import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import ZAI from 'z-ai-web-dev-sdk'
import mammoth from 'mammoth'

// Import pdf-parse using require (it doesn't have a proper ESM default export)
const pdfParse = require('pdf-parse')

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

// Ensure upload directory exists
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

// Extract text from PDF using pdf-parse (Node.js library)
async function extractTextFromPDF(filePath: string): Promise<string> {
  try {
    const dataBuffer = readFileSync(filePath)
    const data = await pdfParse(dataBuffer)
    return data.text
  } catch (error) {
    console.error('Error extracting text from PDF:', error)
    throw new Error('Erreur lors de l\'extraction du texte du PDF')
  }
}

// Helper function to read file as Buffer
function readFileAsync(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fs = require('fs')
    fs.readFile(filePath, (err: any, data: Buffer) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

// Extract text from DOCX using mammoth (Node.js library)
async function extractTextFromDOCX(filePath: string): Promise<string> {
  try {
    const dataBuffer = await readFileAsync(filePath)
    const result = await mammoth.extractRawText({ buffer: dataBuffer })
    return result.value
  } catch (error) {
    console.error('Error extracting text from DOCX:', error)
    throw new Error('Erreur lors de l\'extraction du texte du DOCX')
  }
}

// Extract text based on file type
async function extractText(filePath: string, fileType: string): Promise<string> {
  if (fileType === 'pdf') {
    return extractTextFromPDF(filePath)
  } else if (fileType === 'docx') {
    return extractTextFromDOCX(filePath)
  } else {
    throw new Error('Type de fichier non supporté')
  }
}

// Evaluate the student work using LLM
async function evaluateWork(
  assignmentTitle: string,
  subject: string,
  instructions: string,
  criteria: string,
  studentWork: string
): Promise<any> {
  const zai = await ZAI.create()

  const systemPrompt = `Tu es un enseignant expert et impartial. Ton rôle est d'évaluer des travaux d'étudiants de manière constructive et détaillée.

IMPORTANT: Tu dois TOUJOURS répondre en JSON avec exactement cette structure:
{
  "summary": "résumé bref de l'évaluation en 2-3 phrases",
  "strengths": ["point fort 1", "point fort 2", ...],
  "improvements": ["point à améliorer 1", "point à améliorer 2", ...],
  "grade": "note sur 20 (ex: 14/20)",
  "detailedAnalysis": "analyse détaillée et constructive"
}

Règles d'évaluation:
- Sois objectif et constructif
- Donne des retours actionnables
- La note doit être réaliste et justifiée
- Les points forts doivent être sincères
- Les points à améliorer doivent être précis et constructifs
- Adapte ton évaluation à la matière: ${subject}
- Ne sois pas trop sévère, encourage l'étudiant
- Si le travail est excellent, donne une note élevée (16-20)
- Si le travail est bon mais avec des erreurs, donne une note moyenne (12-15)
- Si le travail a des problèmes majeurs, donne une note plus basse (8-11)
- Seulement en cas de travail incomplet ou très mauvais, donne une note basse (<8)`

  const userPrompt = `Évalue le travail suivant:

TITRE DU DEVOIR: ${assignmentTitle}
MATIÈRE: ${subject}

CONSIGNES DU DEVOIR:
${instructions}

CRITÈRES D'ÉVALUATION:
${criteria}

TRAVAIL DE L'ÉTUDIENT:
${studentWork}

Évalue ce travail en tenant compte des consignes et des critères fournis. Réponds UNIQUEMENT en JSON avec la structure demandée.`

  try {
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      thinking: { type: 'disabled' }
    })

    const response = completion.choices[0]?.message?.content

    if (!response) {
      throw new Error('Pas de réponse du LLM')
    }

    // Try to parse JSON from response
    let jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    } else {
      throw new Error('Réponse invalide du LLM')
    }
  } catch (error) {
    console.error('Error evaluating work:', error)
    throw new Error('Erreur lors de l\'évaluation par l\'IA')
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureUploadDir()

    const formData = await req.formData()
    const file = formData.get('file') as File
    const assignmentTitle = formData.get('assignmentTitle') as string
    const subject = formData.get('subject') as string
    const instructions = formData.get('instructions') as string
    const criteria = formData.get('criteria') as string

    if (!file) {
      return NextResponse.json(
        { error: 'Aucun fichier fourni' },
        { status: 400 }
      )
    }

    if (!instructions || !criteria) {
      return NextResponse.json(
        { error: 'Consignes ou critères manquants' },
        { status: 400 }
      )
    }

    // Generate unique filename
    const timestamp = Date.now()
    const fileName = `${timestamp}-${file.name}`
    const filePath = path.join(UPLOAD_DIR, fileName)

    // Save file
    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    await writeFile(filePath, buffer)

    try {
      // Extract text from file
      const fileType = fileName.split('.').pop()?.toLowerCase() || ''
      const studentWork = await extractText(filePath, fileType)

      if (!studentWork || studentWork.trim().length < 10) {
        throw new Error('Impossible d\'extraire le texte du fichier. Vérifiez que le fichier contient du texte extractible.')
      }

      // Evaluate using LLM
      const evaluation = await evaluateWork(
        assignmentTitle,
        subject,
        instructions,
        criteria,
        studentWork
      )

      return NextResponse.json(evaluation)
    } finally {
      // Clean up uploaded file
      try {
        await unlink(filePath)
      } catch (error) {
        console.error('Error deleting file:', error)
      }
    }
  } catch (error) {
    console.error('Error in evaluate API:', error)
    const errorMessage = error instanceof Error ? error.message : 'Erreur lors de l\'évaluation'
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
