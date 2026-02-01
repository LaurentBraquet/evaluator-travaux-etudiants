import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'

// ON RETIRE LE SDK CAPRICIEUX
// import ZAI from 'z-ai-web-dev-sdk'

const UPLOAD_DIR = '/tmp/uploads'

// --- REMPLACEMENT DU SDK PAR UNE VERSION "SERVERLESS FRIENDLY" ---
// Cette classe imite exactement le comportement attendu sans avoir besoin de fichiers de config
class ZAIClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.apiEndpoint = config.apiEndpoint || 'https://api.z-ai.com';
    
    // Structure compatible avec votre code existant
    this.chat = {
      completions: {
        create: this.createCompletion.bind(this)
      }
    };
  }

  async createCompletion(params) {
    if (!this.apiKey) {
      throw new Error("API Key manquante pour ZAI");
    }

    // On suppose que l'API suit le standard OpenAI (très probable vu la signature)
    // Si l'endpoint final est différent (ex: /v1/chat/completions), ajustez ici.
    const url = `${this.apiEndpoint}/v1/chat/completions`; 

    console.log(`Appel API direct vers: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Erreur API ZAI (${response.status}): ${errorBody}`);
    }

    return await response.json();
  }

  static async create(config) {
    // Si config n'est pas passé, on essaie de lire les variables d'env
    const finalConfig = config || {
      apiKey: process.env.Z_AI_API_KEY || '',
      apiEndpoint: 'https://api.z-ai.com'
    };
    return new ZAIClient(finalConfig);
  }
}

// Ensure upload directory exists
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

// Initialize ZAI (Version simplifiée et robuste)
async function initZAI() {
  console.log('Initialisation du client ZAI personnalisé (sans fichier config)...');
  
  // Utilisation directe de notre classe personnalisée
  // Plus besoin de créer des fichiers dans /tmp ou de patcher fs
  return ZAIClient.create({
    apiEndpoint: 'https://api.z-ai.com',
    apiKey: process.env.Z_AI_API_KEY || '' // Assurez-vous que cette VAR est dans Vercel
  });
}

// Extract text from PDF using pdf-parse
async function extractTextFromPDF(filePath) {
  try {
    console.log('Starting PDF extraction from:', filePath)
    
    // Polyfill DOMMatrix
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
async function evaluateWork(
  assignmentTitle,
  subject,
  instructions,
  criteria,
  studentWork
) {
  const zai = await initZAI() // Retourne maintenant notre client léger

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
- Adapte ton évaluation à la matière: ${subject}
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
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // Retrait de 'thinking' si l'API standard ne le supporte pas, ou laissez-le si ZAI l'utilise
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
      console.log('File type:', fileType, 'File name:', fileName)
      
      const studentWork = await extractText(filePath, fileType)
      
      if (!studentWork || studentWork.trim().length < 10) {
        throw new Error(`Texte extrait trop court (${studentWork?.length || 0} caractères).`)
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
      try { await unlink(filePath) } catch (error) { console.error('File cleanup error:', error) }
    }
  } catch (error) {
    console.error('Error in evaluate API:', error)
    const errorMessage = error instanceof Error ? error.message : 'Erreur lors de l\'évaluation'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}