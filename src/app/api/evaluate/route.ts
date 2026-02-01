import { NextRequest, NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'

const UPLOAD_DIR = '/tmp/uploads'

// --- CLIENT PERSONNALISÉ (CORRIGÉ) ---
class ZAIClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    // URL par défaut corrigée vers OpenAI si Z-AI n'est pas utilisé, 
    // ou configurable via la variable Z_AI_API_ENDPOINT
    this.apiEndpoint = config.apiEndpoint || 'https://api.openai.com/v1'; 
    
    this.chat = {
      completions: {
        create: this.createCompletion.bind(this)
      }
    };
  }

  async createCompletion(params) {
    if (!this.apiKey) {
      throw new Error("Clé API manquante. Ajoutez Z_AI_API_KEY dans Vercel.");
    }

    // Construction correcte de l'URL
    // Si l'endpoint finit déjà par /v1 ou /chat/completions, on ne l'ajoute pas deux fois
    let url = this.apiEndpoint;
    if (!url.endsWith('/chat/completions')) {
        // Nettoyage des slashs finaux potentiels
        url = url.replace(/\/+$/, '');
        // Si l'URL de base est juste le domaine, on ajoute le chemin standard
        if (!url.includes('/v1')) {
            url += '/v1/chat/completions';
        } else {
            url += '/chat/completions';
        }
    }

    console.log(`Tentative de connexion à: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Erreur API (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      // Gestion spécifique des erreurs réseau (DNS, SSL, etc.)
      if (error.cause && error.cause.code === 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME') {
         throw new Error(`L'URL de l'API est invalide (${url}). Vérifiez la variable Z_AI_API_ENDPOINT.`);
      }
      throw error;
    }
  }

  static async create(config) {
    const finalConfig = config || {
      apiKey: process.env.Z_AI_API_KEY || '',
      apiEndpoint: process.env.Z_AI_API_ENDPOINT || 'https://api.openai.com/v1' 
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

// Initialize ZAI
async function initZAI() {
  return ZAIClient.create({
    apiEndpoint: process.env.Z_AI_API_ENDPOINT, // Laissera la valeur par défaut si vide
    apiKey: process.env.Z_AI_API_KEY 
  });
}

// ... (Gardez vos fonctions extractTextFromPDF, extractTextFromDOCX, extractText ici à l'identique) ...
// Pour la brièveté, je ne les répète pas mais elles sont indispensables !
async function extractTextFromPDF(filePath) {
    // ... VOS FONCTIONS D'EXTRACTION RESTENT ICI ...
    if (typeof global.DOMMatrix === 'undefined') {
        global.DOMMatrix = class DOMMatrix { constructor() {}; multiply() {return this}; translate() {return this}; scale() {return this}; rotate() {return this} }
    }
    const pdfParse = require('pdf-parse');
    const dataBuffer = await readFile(filePath);
    return (await pdfParse(dataBuffer)).text.trim();
}

async function extractTextFromDOCX(filePath) {
    const dataBuffer = await readFile(filePath);
    return (await mammoth.extractRawText({ buffer: dataBuffer })).value;
}

async function extractText(filePath, fileType) {
    if (fileType === 'pdf') return extractTextFromPDF(filePath);
    if (fileType === 'docx') return extractTextFromDOCX(filePath);
    throw new Error('Type non supporté');
}

// Evaluate student work
async function evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork) {
  const zai = await initZAI()

  const systemPrompt = `Tu es un enseignant expert... (votre prompt système complet)` // Assurez-vous de remettre tout le texte
  const userPrompt = `Évalue le travail suivant:\nTITRE: ${assignmentTitle}\nMATIÈRE: ${subject}\nCONSIGNES: ${instructions}\nCRITÈRES: ${criteria}\nTRAVAIL: ${studentWork}\nRéponds UNIQUEMENT en JSON.`

  try {
    const completion = await zai.chat.completions.create({
      // IMPORTANT: Le modèle doit être spécifié si vous utilisez OpenAI ou compatible
      model: "gpt-4-turbo-preview", 
      messages: [
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // 'thinking' est spécifique à certains modèles, à retirer pour OpenAI standard
      // thinking: { type: 'disabled' } 
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
    // ... (Reste de la logique de récupération des fichiers identique) ...
    const file = formData.get('file');
    const assignmentTitle = formData.get('assignmentTitle');
    const subject = formData.get('subject');
    const instructions = formData.get('instructions');
    const criteria = formData.get('criteria');

    if (!file) return NextResponse.json({ error: 'Fichier manquant' }, { status: 400 })

    const timestamp = Date.now()
    const fileName = `${timestamp}-${file.name}`
    const filePath = path.join(UPLOAD_DIR, fileName)
    
    const bytes = await file.arrayBuffer()
    await writeFile(filePath, Buffer.from(bytes))

    try {
      const fileType = fileName.split('.').pop()?.toLowerCase() || ''
      const studentWork = await extractText(filePath, fileType)
      
      if (!studentWork || studentWork.length < 10) throw new Error("Texte insuffisant")

      const result = await evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork)
      return NextResponse.json(result)

    } finally {
      await unlink(filePath).catch(console.error)
    }
  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}