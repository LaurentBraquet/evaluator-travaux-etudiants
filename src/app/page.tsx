'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Upload, FileText, CheckCircle2, Printer, Loader2, AlertCircle } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

type EvaluationResult = {
  summary: string
  strengths: string[]
  improvements: string[]
  score?: string
  grade?: string
  detailedAnalysis: string
}

export default function Home() {
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [assignmentTitle, setAssignmentTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [instructions, setInstructions] = useState('')
  const [criteria, setCriteria] = useState('')
  const [result, setResult] = useState<EvaluationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      const fileExtension = selectedFile.name.split('.').pop()?.toLowerCase()
      if (fileExtension !== 'pdf' && fileExtension !== 'docx') {
        toast({
          title: 'Type de fichier non supporté',
          description: 'Veuillez uploader un fichier PDF ou DOCX.',
          variant: 'destructive'
        })
        return
      }
      setFile(selectedFile)
      setError(null)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!file) {
      toast({
        title: 'Fichier manquant',
        description: 'Veuillez sélectionner un fichier à évaluer.',
        variant: 'destructive'
      })
      return
    }

    if (!instructions || !criteria) {
      toast({
        title: 'Informations manquantes',
        description: 'Veuillez remplir les consignes et les critères d\'évaluation.',
        variant: 'destructive'
      })
      return
    }

    setIsLoading(true)
    setError(null)
    setResult(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('assignmentTitle', assignmentTitle || 'Devoir sans titre')
      formData.append('subject', subject || 'Général')
      formData.append('instructions', instructions)
      formData.append('criteria', criteria)

      const response = await fetch('/api/evaluate', {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Erreur lors de l\'évaluation')
      }

      const data = await response.json()
      setResult(data)
      toast({
        title: 'Évaluation terminée',
        description: 'Le travail a été évalué avec succès.'
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Une erreur est survenue'
      setError(errorMessage)
      toast({
        title: 'Erreur',
        description: errorMessage,
        variant: 'destructive'
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handlePrint = () => {
    window.print()
  }

  const handleReset = () => {
    setFile(null)
    setAssignmentTitle('')
    setSubject('')
    setInstructions('')
    setCriteria('')
    setResult(null)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-900 dark:text-slate-100 mb-2">
            Évaluation de Travaux Étudiants par IA
          </h1>
          <p className="text-slate-600 dark:text-slate-400">
            Utilisez l'intelligence artificielle pour évaluer les travaux selon vos critères
          </p>
        </header>

        {!result ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Soumettre un travail pour évaluation
              </CardTitle>
              <CardDescription>
                Remplissez les informations ci-dessous et uploadez le travail de l'étudiant
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="assignmentTitle">Titre du devoir</Label>
                    <Input
                      id="assignmentTitle"
                      placeholder="Ex: Lettre de motivation"
                      value={assignmentTitle}
                      onChange={(e) => setAssignmentTitle(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="subject">Matière</Label>
                    <Select value={subject} onValueChange={setSubject}>
                      <SelectTrigger>
                        <SelectValue placeholder="Sélectionner une matière" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="français">Français</SelectItem>
                        <SelectItem value="mathématiques">Mathématiques</SelectItem>
                        <SelectItem value="géographie">Géographie</SelectItem>
                        <SelectItem value="histoire">Histoire</SelectItem>
                        <SelectItem value="anglais">Anglais</SelectItem>
                        <SelectItem value="sciences">Sciences</SelectItem>
                        <SelectItem value="philosophie">Philosophie</SelectItem>
                        <SelectItem value="autre">Autre</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="instructions">Consignes du devoir</Label>
                  <Textarea
                    id="instructions"
                    placeholder="Décrivez ce qui était demandé aux étudiants..."
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={4}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="criteria">Critères d'évaluation</Label>
                  <Textarea
                    id="criteria"
                    placeholder="Listez les critères sur lesquels le travail doit être évalué (ex: structure, clarté, pertinence du contenu, grammaire, etc.)..."
                    value={criteria}
                    onChange={(e) => setCriteria(e.target.value)}
                    rows={4}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="file">Fichier du travail (PDF ou DOCX)</Label>
                  <div className="flex items-center gap-4">
                    <Input
                      id="file"
                      type="file"
                      accept=".pdf,.docx"
                      onChange={handleFileChange}
                      className="flex-1"
                    />
                    {file && (
                      <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                        <CheckCircle2 className="h-4 w-4" />
                        {file.name}
                      </div>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="p-4 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={isLoading || !file}
                  className="w-full"
                  size="lg"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Évaluation en cours...
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" />
                      Évaluer le travail
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    Résultats de l'évaluation
                  </CardTitle>
                  <CardDescription className="mt-2">
                    {assignmentTitle} - {subject}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleReset}>
                    Nouvelle évaluation
                  </Button>
                  <Button size="sm" onClick={handlePrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    Imprimer
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {result.grade && (
                <div className="p-6 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 rounded-lg border-2 border-blue-200 dark:border-blue-800">
                  <div className="text-center">
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">Note estimée</p>
                    <p className="text-4xl font-bold text-blue-600 dark:text-blue-400">{result.grade}</p>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Résumé de l'évaluation</h3>
                <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{result.summary}</p>
              </div>

              {result.strengths && result.strengths.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-green-700 dark:text-green-400">Points forts</h3>
                  <ul className="space-y-2">
                    {result.strengths.map((strength, index) => (
                      <li key={index} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                        <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                        <span>{strength}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.improvements && result.improvements.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-amber-700 dark:text-amber-400">Points à améliorer</h3>
                  <ul className="space-y-2">
                    {result.improvements.map((improvement, index) => (
                      <li key={index} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-sm font-medium flex-shrink-0 mt-0.5">
                          {index + 1}
                        </span>
                        <span>{improvement}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Analyse détaillée</h3>
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
                  <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                    {result.detailedAnalysis}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <footer className="mt-12 text-center text-sm text-slate-500 dark:text-slate-500">
          <p>Application d'évaluation par IA • Sans base de données • Résultats affichés uniquement</p>
        </footer>
      </div>
    </div>
  )
}
