import { NextResponse } from 'next/server'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mammoth from 'mammoth'

const UPLOAD_DIR = '/tmp/uploads'

// --- CLIENT Z.AI ---
class ZAIClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.z.ai';

    this.chat = {
      completions: {
        create: this.createCompletion.bind(this),
      },
    };
  }

  async createCompletion(params) {
    if (!this.apiKey) {
      throw new Error("Clé API manquante. Vérifiez Z_AI_API_KEY.");
    }

    const url = this.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    console.log(`Tentative de connexion à : ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Erreur API (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Erreur Fetch ZAI:', error);
      throw error;
    }
  }

  static async create(config) {
    const finalConfig = {
      apiKey: process.env.Z_AI_API_KEY || '',
      baseUrl: process.env.Z_AI_API_BASE_URL || 'https://api.z.ai',
      ...(config || {}),
    };
    return new ZAIClient(finalConfig);
  }
}

async function initZAI() {
  return ZAIClient.create({});
}

// --- FONCTIONS D’EXTRACTION (inchangées) ---
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true })
  }
}

async function extractTextFromPDF(filePath) {
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
      constructor() {}
      multiply() { return this }
      translate() { return this }
      scale() { return this }
      rotate() { return this }
    }
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

// --- LOGIQUE D’ÉVALUATION ---
async function evaluateWork(assignmentTitle, subject, instructions, criteria, studentWork) {
  const zai = await initZAI();

  const systemPrompt = `Tu es un enseignant expert chargé d'évaluer des devoirs d'étudiants.
  Ton but est de fournir une correction constructive, bienveillante mais rigoureuse.

  Format de réponse attendu (JSON uniquement) :
  {
    "score": "Note sur 20 (ex: 14/20)",
    "feedback": "Commentaire général encourageant",
    "strengths": ["Point fort 1", "Point fort 2"],
    "weaknesses": ["Point faible 1", "Point faible 2"],
    "detailed_corrections": [
      { "original": "Texte fautif cité", "correction": "Suggestion de correction", "explanation": "Pourquoi c'est faux" }
    ]
  }`

  const userPrompt = `Évalue le travail suivant :

TITRE: ${assignmentTitle}
MATIÈRE: ${subject}
CONSIGNES: ${instructions}
CRITÈRES: ${criteria}

TRAVAIL DE L'ÉTUDIANT :
${studentWork}

Réponds UNIQUEMENT en JSON valide sans Markdown.`

  try {
    const completion = await zai.chat.completions.create({
      model: "gpt-4-turbo-preview", // ou le modèle que Z.AI attend
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) throw new Error('Pas de réponse du LLM');

    let jsonString = response;
    const match = response.match(/\{[\s\S]*\}/);
    if (match) jsonString = match[0];

    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Erreur lors de l'évaluation:", error);
    throw new Error(`Erreur IA: ${error.message}`);
  }
}

// --- ROUTE POST ---
export async function POST(req) {
  try {
    await ensureUploadDir();
    const formData = await req.formData();

    const file = formData.get('file');
    const assignmentTitle = formData.get('assignmentTitle');
    const subject = formData.get('subject');
    const instructions = formData.get('instructions');
    const criteria = formData.get('criteria');

    if (!file) {
      return NextResponse.json({ error: 'Fichier manquant' }, { status: 400 });
    }

    const timestamp = Date.now();
    const fileName = `${timestamp}-${file.name}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const bytes = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(bytes));

    try {
      const fileType = fileName.split('.').pop()?.toLowerCase() || '';
      const studentWork = await extractText(filePath, fileType);

      if (!studentWork || studentWork.length < 10) {
        throw new Error("Le fichier semble vide ou illisible.");
      }

      const result = await evaluateWork(
        assignmentTitle,
        subject,
        instructions,
        criteria,
        studentWork
      );

      return NextResponse.json(result);
    } finally {
      await unlink(filePath).catch(console.error);
    }
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}