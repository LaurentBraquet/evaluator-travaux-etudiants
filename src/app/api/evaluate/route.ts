import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import ZAI from 'z-ai-web-dev-sdk'

const UPLOAD_DIR = '/tmp/uploads'

// Ensure upload directory exists
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

// Initialize ZAI with inline configuration (no external config file needed)
async function initZAI() {
  try {
    // Try to create config file in multiple locations
    const fs = require('fs')
    const path = require('path')

    const configContent = JSON.stringify({
      apiEndpoint: 'https://api.z-ai.com',
      apiKey: ''
    }, null, 2)

    // Try different locations where the SDK might look
    const configPaths = [
      '/tmp/.z-ai-config',
      process.cwd() + '/.z-ai-config',
      '/etc/.z-ai-config'
    ]

    for (const configPath of configPaths) {
      try {
        if (!fs.existsSync(configPath)) {
          const dir = path.dirname(configPath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          fs.writeFileSync(configPath, configContent, 'utf8')
          console.log('Created config file at:', configPath)
        }
      } catch (e) {
        console.log('Could not create config at', configPath, ':', e.message)
      }
    }

    // Try creating ZAI instance
    return await ZAI.create()
  } catch (error) {
    console.error('Error initializing ZAI:', error)
    // Fallback: try with inline config
    try {
      return await ZAI.create({
        apiKey: process.env.ZAI_API_KEY || '',
        apiEndpoint: process.env.ZAI_API_ENDPOINT || 'https://api.z-ai.com'
      } as any)
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError)
      throw fallbackError
    }
  }
}

// Extract text from PDF using pdf-parse
async function extractTextFromPDF(filePath: string): Promise<string> {
  try {
    console.log('Starting PDF extraction from:', filePath)

    // Polyfill DOMMatrix for pdf-parse in Node.js environment
    if (typeof (global as any).DOMMatrix === 'undefined') {
      (global as any).DOMMatrix = class DOMMatrix {
        constructor() {}
        multiply() { return this; }
        translate() { return this; }
        scale() { return this; }
        rotate() { return this; }
      }
    }

    // Use require for pdf-parse to avoid ESM issues
    const pdfParse = require('pdf-parse')
    const dataBuffer = await readFile(filePath)
    console.log('File buffer size:', dataBuffer.length, 'bytes')

    // Parse PDF
    const data = await pdfParse(dataBuffer)

    console.log('PDF extraction completed, number of pages:', data.numpages, 'text length:', data.text.length)
    return data.text.trim()
  } catch (error) {
    console.error('Error extracting text from PDF:', error)
    throw new Error(`Erreur lors de l'extraction du texte du PDF: ${error instanceof Error ? error.message : 'Erreur inconnue'}`)
  }
}

// Extract text from DOCX using mammoth
async function extractTextFromDOCX(filePath: string): Promise<string> {
  try {
    console.log('Starting DOCX extraction from:', filePath)

    const dataBuffer = await readFile(filePath)
    console.log('DOCX buffer size:', dataBuffer.length, 'bytes')

    const result = await mammoth.extractRawText({ buffer: dataBuffer })
    console.log('DOCX extraction completed, text length:', result.value.length, 'warnings:', result.messages.length)

    if (result.messages.length > 0) {
      console.log('Mammoth warnings:', result.messages)
    }

    return result.value
  } catch (error) {
    console.error('Error extracting text from DOCX:', error)
    throw new Error(`Erreur lors de l'extraction du texte du DOCX: ${error instanceof Error ? error.message : 'Erreur inconnue'}`)
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

// Evaluate student work using LLM
async function evaluateWork(
  assignmentTitle: string,
  subject: string,
  instructions: string,
  criteria: string,
  studentWork: string
): Promise<any> {
  const zai = await initZAI()

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
    throw new Error(`Erreur lors de l'évaluation par l'IA: ${error instanceof Error ? error.message : 'Erreur inconnue'}`)
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
      console.log('File type:', fileType, 'File name:', fileName)

      const studentWork = await extractText(filePath, fileType)
      console.log('Extracted text preview (first 200 chars):', studentWork.substring(0, 200))

      if (!studentWork || studentWork.trim().length < 10) {
        throw new Error(`Texte extrait trop court (${studentWork?.length || 0} caractères). Vérifiez que le fichier contient du texte extractible.`)
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
