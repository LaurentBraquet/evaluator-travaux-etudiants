import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs' // On garde l'import original
import path from 'path'
import mammoth from 'mammoth'

// NOTE: Pas d'import global de ZAI pour éviter le chargement prématuré

const UPLOAD_DIR = '/tmp/uploads'

async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

// Fonction d'initialisation avec "Virtualisation" du fichier de config
async function initZAI() {
  const fs = require('fs')
  
  // 1. Sauvegarde des méthodes originales du système de fichiers
  const originalExistsSync = fs.existsSync
  const originalReadFileSync = fs.readFileSync
  const originalStatSync = fs.statSync

  // 2. Définition de notre configuration virtuelle
  const virtualConfigContent = JSON.stringify({
    apiEndpoint: 'https://api.z-ai.com',
    apiKey: process.env.Z_AI_API_KEY || '' // Assurez-vous d'avoir cette variable d'env
  }, null, 2)

  try {
    console.log('Activation du patch système de fichiers pour ZAI...')

    // 3. Interception de existsSync
    // Si la librairie demande si le fichier config existe, on dit OUI (true)
    fs.existsSync = (filePath) => {
      if (filePath && filePath.toString().includes('.z-ai-config')) {
        console.log('Intercepted existsSync check for .z-ai-config')
        return true
      }
      return originalExistsSync.call(fs, filePath)
    }

    // 4. Interception de readFileSync
    // Si la librairie essaie de lire le fichier, on lui donne notre JSON virtuel
    fs.readFileSync = (filePath, options) => {
      if (filePath && filePath.toString().includes('.z-ai-config')) {
        console.log('Intercepted readFileSync for .z-ai-config')
        return virtualConfigContent
      }
      return originalReadFileSync.call(fs, filePath, options)
    }

    // 5. Interception de statSync (certaines libs vérifient la taille/date)
    fs.statSync = (filePath, options) => {
        if (filePath && filePath.toString().includes('.z-ai-config')) {
            return {
                isFile: () => true,
                size: virtualConfigContent.length,
                mtime: new Date(),
                ctime: new Date()
            }
        }
        return originalStatSync.call(fs, filePath, options)
    }

    // 6. Import et Initialisation du SDK pendant que le patch est actif
    console.log('Importing ZAI SDK...')
    const ZAIModule = await import('z-ai-web-dev-sdk')
    const ZAI = ZAIModule.default
    
    console.log('Creating ZAI instance...')
    // La librairie va "lire" notre fichier virtuel sans erreur
    return await ZAI.create()

  } catch (error) {
    console.error('Erreur critique lors de l\'initialisation patchée:', error)
    throw error
  } finally {
    // 7. NETTOYAGE CRITIQUE : On remet le système de fichiers dans son état normal
    // C'est indispensable pour ne pas casser le reste de l'application Next.js
    fs.existsSync = originalExistsSync
    fs.readFileSync = originalReadFileSync
    fs.statSync = originalStatSync
    console.log('Système de fichiers restauré.')
  }
}

// --- Le reste de vos fonctions utilitaires (PDF, DOCX) reste identique ---

async function extractTextFromPDF(filePath) {
    // ... (votre code original de parsing PDF)
    // Pour gagner de la place, je ne remets pas tout le code PDF ici s'il fonctionnait déjà
    // Mais assurez-vous de le garder dans votre fichier final !
    try {
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
        throw new Error(`Erreur PDF: ${error.message}`)
      }
}

async function extractTextFromDOCX(filePath) {
    try {
        const dataBuffer = await readFile(filePath)
        const result = await mammoth.extractRawText({ buffer: dataBuffer })
        return result.value
      } catch (error) {
        throw new Error(`Erreur DOCX: ${error.message}`)
      }
}

async function extractText(filePath, fileType) {
  if (fileType === 'pdf') return extractTextFromPDF(filePath)
  if (fileType === 'docx') return extractTextFromDOCX(filePath)
  throw new Error('Type de fichier non supporté')
}

// Evaluate student work using LLM
async function evaluateWork(
  assignmentTitle,
  subject,
  instructions,
  criteria,
  studentWork
) {
  // On appelle notre fonction d'initialisation "magique"
  const zai = await initZAI()

  const systemPrompt = `Tu es un enseignant expert et impartial... (votre prompt système complet)`
  const userPrompt = `Évalue le travail suivant:\nTITRE: ${assignmentTitle}\nMATIÈRE: ${subject}\nCONSIGNES: ${instructions}\nCRITÈRES: ${criteria}\nTRAVAIL: ${studentWork}\nRéponds UNIQUEMENT en JSON.`

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
    if (jsonMatch) return JSON.parse(jsonMatch[0])
    throw new Error('Réponse invalide du LLM')

  } catch (error) {
    console.error('Error evaluating work:', error)
    throw new Error(`Erreur IA: ${error.message}`)
  }
}

export async function POST(req) {
  try {
    await ensureUploadDir()
    const formData = await req.formData()
    
    // Récupération des champs
    const file = formData.get('file')
    const assignmentTitle = formData.get('assignmentTitle')
    const subject = formData.get('subject')
    const instructions = formData.get('instructions')
    const criteria = formData.get('criteria')

    if (!file) return NextResponse.json({ error: 'Fichier manquant' }, { status: 400 })

    // Sauvegarde temporaire
    const timestamp = Date.now()
    const fileName = `${timestamp}-${file.name}`
    const filePath = path.join(UPLOAD_DIR, fileName)
    
    const bytes = await file.arrayBuffer()
    await writeFile(filePath, Buffer.from(bytes))

    try {
      // Extraction et Évaluation
      const fileType = fileName.split('.').pop()?.toLowerCase() || ''
      const studentWork = await extractText(filePath, fileType)
      
      if (!studentWork || studentWork.length < 10) throw new Error("Texte insuffisant")

      const result = await evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork)
      return NextResponse.json(result)

    } finally {
      // Nettoyage
      await unlink(filePath).catch(console.error)
    }
  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}