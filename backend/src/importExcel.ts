import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import XLSX from 'xlsx'

const prisma = new PrismaClient()
const filePath = process.argv[2]
const replace = process.argv.includes('--replace')
const stages = [
  ['Demande envoyée à la compagnie', '#c9822b'],
  ['En vérification chez nous', '#c9822b'],
  ['Retourné à la compagnie pour rectification', '#b23a48'],
  ['Chez le client pour signature', '#3b78b5'],
  ['Chez la compagnie pour signature', '#3b78b5'],
  ['Signé, retourné à la compagnie', '#2f8f6b'],
  ['Signé, retourné au client', '#2f8f6b'],
] as const

const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ')
const key = (value: string) => clean(value).toUpperCase()
const date = (value: unknown) => { const text = clean(value); if (!text) return null; const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? null : parsed }
const value = (row: Record<string, unknown>, ...names: string[]) => Object.entries(row).find(([name]) => names.some((candidate) => key(name) === key(candidate)))?.[1]

async function main() {
  if (!filePath) throw new Error('Usage: npm run db:import -- "chemin\\vers\\fichier.xlsx" [--replace]')
  const workbook = XLSX.readFile(filePath, { cellDates: true })
  const sheet = workbook.Sheets.ETAT
  if (!sheet) throw new Error('La feuille ETAT est introuvable dans le classeur')
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null })
  if (replace) { await prisma.document.deleteMany(); await prisma.contrat.deleteMany(); await prisma.assure.deleteMany(); await prisma.compagnie.deleteMany() }
  for (const [code, [libelle, couleur]] of stages.entries()) await prisma.etape.upsert({ where: { id: code }, update: { code, libelle, couleur }, create: { id: code, code, libelle, couleur } })

  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const nom = clean(value(row, 'ASSURE'))
    if (!nom) { skipped += 1; continue }
    const code = clean(value(row, 'CODE ASSURE')) || null
    const compagnieNom = clean(value(row, 'COMPAGNIE')) || 'Non renseignée'
    const police = clean(value(row, 'N° DE POLICE')) || null
    const nature = clean(value(row, 'NATURE POLICE')) || 'Non renseignée'
    const rawStage = Number(value(row, 'ETAPE'))
    const etapeCode = Number.isInteger(rawStage) && rawStage >= 0 && rawStage <= 6 ? rawStage : 0
    const assure = code ? await prisma.assure.findFirst({ where: { code } }) : await prisma.assure.findFirst({ where: { nom } })
    const assureRecord = assure ?? await prisma.assure.create({ data: { code, nom } })
    const compagnie = await prisma.compagnie.upsert({ where: { nom: compagnieNom }, update: {}, create: { nom: compagnieNom } })
    const contrat = await prisma.contrat.findFirst({ where: { assureId: assureRecord.id, compagnieId: compagnie.id, police, nature } })
    const contratRecord = contrat ?? await prisma.contrat.create({ data: { assureId: assureRecord.id, compagnieId: compagnie.id, police, nature, lieu: clean(value(row, 'FRONTE / LOCAL')) || null } })
    await prisma.document.create({ data: { contratId: contratRecord.id, etapeId: etapeCode, type: key(clean(value(row, "L'AVENANT/CONTRAT"))) || 'CONTRAT', nature: key(clean(value(row, 'NATURE DOCUMENT'))) || 'NON RENSEIGNE', numero: clean(value(row, 'N° AVENANT')) || null, dateEffet: date(value(row, "DATE D'EFFET")), dateEtape: date(value(row, 'l')), remarque: clean(value(row, 'Remarque chargé')) || null } })
    imported += 1
  }
  console.log(JSON.stringify({ filePath, imported, skipped, replace }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())