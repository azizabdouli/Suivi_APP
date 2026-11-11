import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import XLSX from 'xlsx'

const prisma = new PrismaClient()
const risks = [
  'TOUS DOMMAGES SAUF', 'INCENDIE', 'MRP', 'TRO / Matériels électroniques', 'BRIS DE MACHINES', 'TOUS RISQUES ENGINS', 'BRIS DE GLACES', 'RESPONSABILITE CIVILE', 'SRCC', 'Assistance au Voyage', 'ASSURANCE CREDIT', 'ACCIDENT CORPORELS', 'GLOBAL DE BANQUE', 'RC DECENNALE', 'RCMS', 'RC', 'PERTE D\'EXPLOITATION', 'CYBER INSURANCE', 'GAV COLLECTIF', 'TOUS RISQUES CHANTIER', 'MULTIRISUE SERRES', 'Multirisque Habitation', 'TRANSPORTS', 'MULTIRISQUES HOTELIERES', 'TRM', 'MULTIRISQUE AGRICOLE', 'ASSURANCE CONTRE LA GRELE', 'CORPS DE PLAISANCE', 'RESPONSABILITE CIVILE CYBER', 'VOL ET PERTE DES MOYENS DE PAIEMENT', 'FLOTTE', 'VOL', 'ENGINS DE CHANTIER', 'OIL & GAS PACKAGE', 'UMBRELLA LIABILITY', 'MUTIRISQUE HABITATION', 'INDIVIDUEL ACCIDENT', 'NAVIRE', 'EQUIPEMENT MARITIME', 'TRANSPORT / ABONNEMENT', 'CRIME LIABILITY', 'BG', 'P&I', 'CRIME BOND INSURANCE', 'CORPS DE PECHE', '1st EXCESS LIABILITY', '2nd EXCESS LIABILITY', 'RC EVENEMENT', 'VIOLANCES POLITIQUES', 'MRP MAGASIN', 'RESPONSABILITE CIVILE PROFESSIONNELLE POUR P/S', 'RESPONSABILITE CIVILE ENVIRONEMENTALE', 'EPLI',
]
const companies = ['STAR', 'GAT', 'ASTREE', 'LLOYD', 'MAGHREBIA', 'COMAR', 'EL AMANA TAKAFUL', 'ZITOUNA TAKAFUL', 'AT TAKAFULIA', 'MAE', 'CTAMA', 'BNA', 'BH', 'BIAT', 'CARTE', 'AMI']
const stages = [['Demande envoyée à la Compagnie', '#c9822b'], ['Contrat / Avenant en notre possession pour vérification', '#c9822b'], ['Contrat / Avenant retourné à la compagnie pour réctification', '#b23a48'], ['Contrat / Avenant chez le client pour signature', '#3b78b5'], ['Contrat / Avenant chez la compagnie pour signature', '#3b78b5'], ['Contrat / Avenant signé des différentes parties retourné à la compagnie', '#2f8f6b'], ['Contrat / Avenant signé retourné au client après signature de la compagnie', '#2f8f6b']] as const

async function main() {
  const file = process.argv[2]
  let selectedRisks = risks
  let selectedCompanies = companies
  const natures = new Set(['MISE EN PLACE', 'RENOUVELLEMENT', 'ACTUALISATION', 'PROROGATION', 'PRECISION', 'BONIFICATION'])
  if (file) {
    const workbook = XLSX.readFile(file, { cellDates: true })
    const sheet = workbook.Sheets.ETAT || workbook.Sheets[workbook.SheetNames[0]]
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null })
    const values = (column: number) => [...new Set(matrix.map((row) => String(row[column] ?? '').trim()).filter((value) => value && !/^(désignation|nature|compagnie)$/i.test(value)))]
    if (!workbook.Sheets.ETAT) {
      selectedRisks = values(0)
      selectedCompanies = values(1)
    } else {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null })
      rows.forEach((row) => { const entry = Object.entries(row).find(([name]) => name.trim().replace(/\s+/g, ' ').toUpperCase() === 'NATURE DOCUMENT'); const nature = String(entry?.[1] ?? '').trim().replace(/\s+/g, ' '); if (nature) natures.add(nature.toUpperCase()) })
    }
  }
  await prisma.natureRisque.updateMany({ data: { isReference: false } })
  await prisma.compagnie.updateMany({ data: { isReference: false } })
  for (const libelle of selectedRisks) await prisma.natureRisque.upsert({ where: { libelle }, update: { isReference: true }, create: { libelle, isReference: true } })
  for (const nom of selectedCompanies) await prisma.compagnie.upsert({ where: { nom }, update: { isReference: true }, create: { nom, isReference: true } })
  for (const libelle of natures) await prisma.natureAvenant.upsert({ where: { libelle }, update: {}, create: { libelle } })
  for (const [code, [libelle, couleur]] of stages.entries()) await prisma.etape.upsert({ where: { id: code }, update: { code, libelle, couleur }, create: { id: code, code, libelle, couleur } })
  console.log(JSON.stringify({ risks: selectedRisks.length, companies: selectedCompanies.length, naturesAvenant: natures.size, stages: stages.length }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())