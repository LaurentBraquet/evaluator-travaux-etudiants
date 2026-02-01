import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync, writeFileSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
// RETIRÉ: L'import global causait l'erreur avant l'exécution du code
// import ZAI from 'z-ai-web-dev-sdk'

const UPLOAD_DIR = '/tmp/uploads'

// Ensure upload directory exists
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

// Initialize ZAI
async function initZAI() {
  // 1. Définir le chemin de config unique (seul /tmp est inscriptible sur Vercel)
  const configPath = '/tmp/.z-ai-config'
  
  // 2. Créer le contenu de la config
  // Note: Idéalement, utilisez process.env.Z_AI_API_KEY au lieu d'une chaîne vide
  const configContent = JSON.stringify({
    apiEndpoint: 'https://api.z-ai.com',
    apiKey: process.env.Z_AI_API_KEY || '' 
  }, null, 2)

  try {
    // 3. Écrire le fichier de config dans /tmp
    console.log('Writing config to:', configPath)
    writeFileSync(configPath, configContent, 'utf8')
    
    // 4. CRUCIAL POUR VERCEL : 
    // On trompe le SDK pour qu'il pense que le dossier "home" est /tmp
    // Cela l'oblige à chercher la config là où on vient de l'écrire
    process.env.HOME = '/tmp'
    
    console.log('Config created. Importing SDK...')

    // 5. Import Dynamique (nécessaire pour charger le SDK APRÈS la création du fichier)
    const ZAIModule = await import('z-ai-web-dev-sdk')
    const ZAI = ZAIModule.default // Gérer l'export par défaut

    // 6. Tentative de création
    console.log('Attempting ZAI.create()...')
    
    // On essaie d'abord la méthode standard qui devrait maintenant trouver le fichier
    return await ZAI.create()

  } catch (error) {
    console.error('Standard init failed, trying explicit config injection:', error.message)
    
    try {
      // Fallback : Si le fichier n'est toujours pas vu, on force les options
      const ZAIModule = await import('z-ai-web-dev-sdk')
      const ZAI = ZAIModule.default
      
      return await ZAI.create({
        apiEndpoint: 'https://api.z-ai.com',
        apiKey: process.env.Z_AI_API_KEY || ''
      })
    } catch (fallbackError) {
      console.error('All ZAI init attempts failed:', fallbackError)
      throw fallbackError
    }
  }
}

// Extract text from PDF using pdf-parse
async function extractTextFromPDF(filePath) {
  try {
    console.log('Starting PDF extraction from:', filePath)
    
    if (typeof global.DOMMatrix === 'undefined') {
      global.DOMMatrix = class DOMMatrix {
        constructor() {}
        multiply() { return this; }
        translate() { return this; }
        scale() { return this; }
        rotate() { return this; }
      }
    }

    const pdfParse = require('pdf-parse')
    const dataBuffer = await readFile(filePath)
    const data = await pdfParse(dataBuffer)
    
    return data.text.trim()
  } catch (error) {
    console.error('Error extracting text from PDF:', error)
    throw new Error(`Erreur PDF: ${error instanceof Error ? error.message : 'Inconnue'}`)
  }
}

// Extract text from DOCX using mammoth
async function extractTextFromDOCX(filePath) {
  try {
    console.log('Starting DOCX extraction from:', filePath)
    const dataBuffer = await readFile(filePath)
    const result = await mammoth.extractRawText({ buffer: dataBuffer })
    return result.value
  } catch (error) {
    console.error('Error extracting text from DOCX:', error)
    throw new Error(`Erreur DOCX: ${error instanceof Error ? error.message : 'Inconnue'}`)
  }
}

async function extractText(filePath, fileType) {
  if (fileType === 'pdf') return extractTextFromPDF(filePath)
  if (fileType === 'docx') return extractTextFromDOCX(filePath)
  throw new Error('Type de fichier non supporté')
}

// Evaluate student work using LLM
async function evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork) {
  // Initialisation du SDK corrigée
  const zai = await initZAI()

  const systemPrompt = `Tu es un enseignant expert et impartial... (reste du prompt inchangé)`
  
  // ... Reste de la fonction inchangée
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
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      thinking: { type: 'disabled' }
    })
    
    const response = completion.choices[0]?.message?.content
    if (!response) throw new Error('Pas de réponse du LLM')

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

export async function POST(req) {
  try {
    await ensureUploadDir()
    const formData = await req.formData()
    const file = formData.get('file')
    const assignmentTitle = formData.get('assignmentTitle')
    const subject = formData.get('subject')
    const instructions = formData.get('instructions')
    const criteria = formData.get('criteria')

    if (!file) return NextResponse.json({ error: 'Aucun fichier fourni' }, { status: 400 })
    if (!instructions || !criteria) return NextResponse.json({ error: 'Consignes manquantes' }, { status: 400 })

    const timestamp = Date.now()
    const fileName = `${timestamp}-${file.name}`
    const filePath = path.join(UPLOAD_DIR, fileName)

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    await writeFile(filePath, buffer)

    try {
      const fileType = fileName.split('.').pop()?.toLowerCase() || ''
      const studentWork = await extractText(filePath, fileType)
      
      if (!studentWork || studentWork.trim().length < 10) {
        throw new Error(`Texte extrait trop court.`)
      }

      const evaluation = await evaluateWork(
        assignmentTitle,
        subject,
        instructions,
        criteria,
        studentWork
      )
      return NextResponse.json(evaluation)

    } finally {
      try { await unlink(filePath) } catch (e) { console.error(e) }
    }
  } catch (error) {
    console.error('Error in evaluate API:', error)
    return NextResponse.json({ error: error.message || 'Erreur interne' }, { status: 500 })
  }
}