import { NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'

const UPLOAD_DIR = '/tmp/uploads'

// --- CLIENT Z-AI CORRIGÉ ---
class ZAIClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    // CORRECTION MAJEURE ICI : Changement du domaine z-ai.com -> z.ai
    this.apiEndpoint = config.apiEndpoint || 'https://api.z.ai/v1'; 
    
    this.chat = {
      completions: {
        create: this.createCompletion.bind(this)
      }
    };
  }

  async createCompletion(params) {
    if (!this.apiKey) {
      throw new Error("Clé API manquante. Vérifiez Z_AI_API_KEY.");
    }

    let url = this.apiEndpoint;
    
    // Nettoyage et construction de l'URL
    if (!url.endsWith('/chat/completions')) {
        url = url.replace(/\/+$/, '');
        // Gestion souple : si l'URL fournie est juste le domaine, on ajoute le chemin
        if (!url.includes('/v1')) {
            url += '/v1/chat/completions';
        } else {
            url += '/chat/completions';
        }
    }

    console.log(`Tentative de connexion à : ${url}`);

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
      // Si on a encore une erreur de domaine inconnu, on aide l'utilisateur
      if (error.cause && error.cause.code === 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME') {
          throw new Error(`Le domaine de l'API est introuvable (${url}). Êtes-vous sûr de l'adresse ?`);
      }
      throw error;
    }
  }

  static async create(config) {
    const finalConfig = config || {
      apiKey: process.env.Z_AI_API_KEY || '',
      // Priorité à la variable d'env, sinon fallback sur z.ai
      apiEndpoint: process.env.Z_AI_API_ENDPOINT || 'https://api.z.ai/v1'
    };
    return new ZAIClient(finalConfig);
  }
}

// --- UTILITAIRES FICHIERS ---
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

async function extractTextFromPDF(filePath) {
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
    throw new Error('Format non supporté');
}

// --- LOGIQUE MÉTIER ---

async function initZAI() {
  return ZAIClient.create({
    apiKey: process.env.Z_AI_API_KEY,
    apiEndpoint: process.env.Z_AI_API_ENDPOINT // Laissera la valeur par défaut (z.ai) si vide
  });
}

async function evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork) {
  const zai = await initZAI()
  
  const systemPrompt = `Tu es un enseignant expert... (Remets ton prompt système complet ici)`
  const userPrompt = `Évalue le travail suivant:\nTITRE: ${assignmentTitle}\nMATIÈRE: ${subject}\nCONSIGNES: ${instructions}\nCRITÈRES: ${criteria}\nTRAVAIL: ${studentWork}\nRéponds UNIQUEMENT en JSON.`

  try {
    const completion = await zai.chat.completions.create({
      model: "gpt-4-turbo-preview", // Vérifie si Z.AI demande un nom de modèle spécifique
      messages: [
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
    
    const response = completion.choices[0]?.message?.content
    if (!response) throw new Error('Pas de réponse du LLM')
    
    let jsonString = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonString = jsonMatch[0];
    
    return JSON.parse(jsonString)
  } catch (error) {
    console.error('Error evaluating work:', error)
    throw new Error(`Erreur IA: ${error.message}`)
  }
}

export async function POST(req) {
  try {
    await ensureUploadDir()
    const formData = await req.formData()
    
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