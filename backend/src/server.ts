import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'

process.env.DATABASE_URL ??= 'postgresql://suivi_app:suivi_app_dev@localhost:5432/suivi_contractuel'

const app = express()
const prisma = new PrismaClient()
const port = Number(process.env.PORT ?? 3000)
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }))
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return response.json({ status: 'ok', database: 'ok', service: 'suivi-contractuel-api', timestamp: new Date().toISOString() })
  } catch {
    return response.status(503).json({ status: 'degraded', database: 'unavailable', service: 'suivi-contractuel-api' })
  }
})

app.get('/api/dashboard', async (_request, response) => {
  const [clients, contracts, documents, blocked, stages, companies] = await Promise.all([
    prisma.assure.count(),
    prisma.contrat.count(),
    prisma.document.count(),
    prisma.document.count({ where: { remarque: { contains: 'bloqu', mode: 'insensitive' } } }),
    prisma.etape.findMany({ include: { _count: { select: { documents: true } } }, orderBy: { code: 'asc' } }),
    prisma.compagnie.findMany({ include: { _count: { select: { contrats: true } } }, orderBy: { nom: 'asc' } }),
  ])
  return response.json({ clients, contracts, documents, blocked, stages: stages.map((stage) => ({ code: stage.code, label: stage.libelle, color: stage.couleur, count: stage._count.documents })), companies: companies.map((company) => ({ name: company.nom, count: company._count.contrats })) })
})

app.get('/api/references', async (_request, response) => {
  const [risks, naturesAvenant, companies, stages] = await Promise.all([
    prisma.natureRisque.findMany({ where: { isReference: true }, orderBy: { libelle: 'asc' } }),
    prisma.natureAvenant.findMany({ orderBy: { libelle: 'asc' } }),
    prisma.compagnie.findMany({ where: { isReference: true }, orderBy: { nom: 'asc' } }),
    prisma.etape.findMany({ orderBy: { code: 'asc' } }),
  ])
  return response.json({ risks, naturesAvenant, companies, stages, locations: ['LOCAL', 'FRONTE'], documentTypes: ['CONTRAT', 'AVENANT'] })
})

app.get('/api/documents', async (request, response) => {
  const limit = Math.min(Number(request.query.limit ?? 50), 200)
  const documents = await prisma.document.findMany({ take: limit, orderBy: { updatedAt: 'desc' }, include: { etape: true, contrat: { include: { assure: true, compagnie: true } } } })
  return response.json(documents)
})

const clientSchema = z.object({ nom: z.string().trim().min(2), code: z.string().trim().nullable().optional(), contact: z.string().trim().nullable().optional() })
const documentSchema = z.object({
  assureId: z.number().int().positive().optional(),
  nomAssure: z.string().trim().min(2),
  codeAssure: z.string().trim().nullable().optional(),
  compagnie: z.string().trim().min(1),
  police: z.string().trim().nullable().optional(),
  naturePolice: z.string().trim().min(1),
  lieu: z.string().trim().nullable().optional(),
  type: z.string().trim().min(1),
  natureDocument: z.string().trim().min(1),
  numero: z.string().trim().nullable().optional(),
  etapeId: z.number().int().min(0).max(6),
  dateEtape: z.string().nullable().optional(),
  dateEffet: z.string().nullable().optional(),
  remarque: z.string().trim().nullable().optional(),
})

app.get('/api/clients', async (request, response) => {
  const search = String(request.query.search ?? '').trim()
  const clients = await prisma.assure.findMany({
    where: search ? { OR: [{ nom: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] } : undefined,
    include: { contrats: { include: { documents: { select: { id: true, etapeId: true } } } } },
    orderBy: { nom: 'asc' },
    take: 500,
  })
  return response.json(clients.map(({ contrats, ...client }) => ({ ...client, _count: { contrats: contrats.length }, documents: contrats.reduce((count, contrat) => count + contrat.documents.length, 0), inProgress: contrats.reduce((count, contrat) => count + contrat.documents.filter((document) => document.etapeId < 5).length, 0) })))
})

app.post('/api/clients', async (request, response) => {
  const result = clientSchema.safeParse(request.body)
  if (!result.success) return response.status(400).json({ error: 'Client invalide', details: result.error.flatten() })
  const client = await prisma.assure.create({ data: { nom: result.data.nom, code: result.data.code || null, contact: result.data.contact || null } })
  return response.status(201).json(client)
})

app.get('/api/clients/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id)) return response.status(400).json({ error: 'Identifiant invalide' })
  const client = await prisma.assure.findUnique({ where: { id }, include: { contrats: { include: { compagnie: true, documents: { include: { etape: true }, orderBy: { updatedAt: 'desc' } } }, orderBy: { nature: 'asc' } } } })
  if (!client) return response.status(404).json({ error: 'Client introuvable' })
  return response.json(client)
})

app.put('/api/clients/:id', async (request, response) => {
  const result = clientSchema.safeParse(request.body)
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || !result.success) return response.status(400).json({ error: 'Client invalide' })
  const client = await prisma.assure.update({ where: { id }, data: { nom: result.data.nom, code: result.data.code || null, contact: result.data.contact || null } })
  return response.json(client)
})

app.delete('/api/clients/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id)) return response.status(400).json({ error: 'Identifiant invalide' })
  await prisma.$transaction(async (transaction) => {
    const contracts = await transaction.contrat.findMany({ where: { assureId: id }, select: { id: true } })
    const contractIds = contracts.map((contract) => contract.id)
    if (contractIds.length) await transaction.document.deleteMany({ where: { contratId: { in: contractIds } } })
    await transaction.contrat.deleteMany({ where: { assureId: id } })
    await transaction.assure.delete({ where: { id } })
  })
  return response.status(204).send()
})

const dateOrNull = (value?: string | null) => value ? new Date(value) : null
async function findOrCreateContract(data: z.infer<typeof documentSchema>) {
  const assure = data.assureId ? await prisma.assure.findUnique({ where: { id: data.assureId } }) : await prisma.assure.findFirst({ where: data.codeAssure ? { code: data.codeAssure } : { nom: data.nomAssure } })
  const assureRecord = assure ?? await prisma.assure.create({ data: { nom: data.nomAssure, code: data.codeAssure || null } })
  const compagnie = await prisma.compagnie.upsert({ where: { nom: data.compagnie }, update: {}, create: { nom: data.compagnie } })
  const existing = await prisma.contrat.findFirst({ where: { assureId: assureRecord.id, compagnieId: compagnie.id, police: data.police || null, nature: data.naturePolice } })
  const contrat = existing ?? await prisma.contrat.create({ data: { assureId: assureRecord.id, compagnieId: compagnie.id, police: data.police || null, nature: data.naturePolice, lieu: data.lieu || null } })
  return contrat
}

app.post('/api/documents', async (request, response) => {
  const result = documentSchema.safeParse(request.body)
  if (!result.success) return response.status(400).json({ error: 'Document invalide', details: result.error.flatten() })
  const contrat = await findOrCreateContract(result.data)
  const document = await prisma.document.create({ data: { contratId: contrat.id, etapeId: result.data.etapeId, type: result.data.type, nature: result.data.natureDocument || 'MISE EN PLACE', numero: result.data.numero || null, dateEffet: dateOrNull(result.data.dateEffet), dateEtape: dateOrNull(result.data.dateEtape), remarque: result.data.remarque || null } })
  return response.status(201).json(document)
})

app.put('/api/documents/:id', async (request, response) => {
  const result = documentSchema.safeParse(request.body)
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || !result.success) return response.status(400).json({ error: 'Document invalide' })
  const existing = await prisma.document.findUnique({ where: { id }, include: { contrat: true } })
  if (!existing) return response.status(404).json({ error: 'Document introuvable' })
  const compagnie = await prisma.compagnie.upsert({ where: { nom: result.data.compagnie }, update: {}, create: { nom: result.data.compagnie } })
  await prisma.assure.update({ where: { id: existing.contrat.assureId }, data: { nom: result.data.nomAssure, code: result.data.codeAssure || null } })
  await prisma.contrat.update({ where: { id: existing.contratId }, data: { compagnieId: compagnie.id, police: result.data.police || null, nature: result.data.naturePolice, lieu: result.data.lieu || null } })
  const document = await prisma.document.update({ where: { id }, data: { etapeId: result.data.etapeId, type: result.data.type, nature: result.data.natureDocument || 'MISE EN PLACE', numero: result.data.numero || null, dateEffet: dateOrNull(result.data.dateEffet), dateEtape: dateOrNull(result.data.dateEtape), remarque: result.data.remarque || null } })
  return response.json(document)
})

app.patch('/api/documents/:id/stage', async (request, response) => {
  const id = Number(request.params.id)
  const result = z.object({ etapeId: z.number().int().min(0).max(6) }).safeParse(request.body)
  if (!Number.isInteger(id) || !result.success) return response.status(400).json({ error: 'Étape invalide' })
  const document = await prisma.document.update({ where: { id }, data: { etapeId: result.data.etapeId, dateEtape: new Date() }, include: { etape: true } })
  return response.json(document)
})

app.delete('/api/documents/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id)) return response.status(400).json({ error: 'Identifiant invalide' })
  await prisma.document.delete({ where: { id } })
  return response.status(204).send()
})

app.post('/api/stages/validate', (request, response) => {
  const result = z.object({ label: z.string().min(1), color: z.string().regex(/^#[0-9a-f]{6}$/i), count: z.number().int().nonnegative() }).safeParse(request.body)
  if (!result.success) return response.status(400).json({ error: 'Étape invalide', details: result.error.flatten() })
  return response.status(201).json(result.data)
})

app.use((_request, response) => response.status(404).json({ error: 'Route introuvable' }))
app.listen(port, () => console.log(`API started on http://localhost:${port}`))