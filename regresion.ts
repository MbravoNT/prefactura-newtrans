// Regresión: motor TS vs salida de referencia de motor.py v0.3.
// Uso: node --experimental-strip-types regresion.ts <carpeta con ref_*.json, reglas.json, carga_erp/*.json y CSV>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leerCsv, procesar } from './supabase/functions/procesar-prefactura/motor.ts';
import type { Erp, Tramos } from './supabase/functions/procesar-prefactura/motor.ts';

const dir = process.argv[2];
const leer = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8').replace(/\bNaN\b/g, 'null'));   // Python escribe NaN
const filas = (t: string) => leer(`carga_erp/${t}.json`).filas;

const CIUDADES: [string, string][] = [['SANTIAGO', 'SCL'], ['VALPARAISO', 'VAP'], ['VIÑA DEL MAR', 'VIÑ'], ['RANCAGUA', 'RCG'],
  ['TALCA', 'ZCA'], ['CHILLAN', 'YAI'], ['CONCEPCION', 'CCP'], ['LOS ANGELES', 'LSQ'], ['TEMUCO', 'ZCO'], ['VALDIVIA', 'ZAL'],
  ['OSORNO', 'ZOS'], ['PUERTO MONTT', 'PMC'], ['CASTRO', 'CTR'], ['LA SERENA', 'LSC'], ['COQUIMBO', 'CQB'], ['OVALLE', 'OVL'],
  ['COPIAPO', 'CPO'], ['VALLENAR', 'VLL'], ['ANTOFAGASTA', 'ANF'], ['CALAMA', 'CJC'], ['IQUIQUE', 'IQQ'], ['ARICA', 'ARI'],
  ['COYHAIQUE', 'GXQ'], ['PUNTA ARENAS', 'PUQ'], ['TAL TAL', 'TAL'], ['LOS ANDES', 'LAC'], ['SAN ANTONIO', 'SAT'],
  ['LOS VILOS', 'LVL'], ['SAN FERNANDO', 'SAF'], ['CURICO', 'CCO']];

const erp: Erp = {
  sucursales: filas('sucursales'),
  contratos: filas('contratos').sort((a: any, b: any) => a.fila - b.fila),
  tarifas: new Map(filas('tarifas').map((t: any) => [`${t.convenio}|${t.servicio}|${t.via}|${t.origen}|${t.destino}`, t.tramos as Tramos])),
  servicios: new Map(filas('servicios').map((s: any) => [s.nombre, s.codigo])),
  ciudades: new Map(CIUDADES),
  ejecutivos: new Map([['96625950', 'BARBARA MENIQUE'], ['76111113', 'BARBARA MENIQUE']]),
};
const reglas = leer('motor/regresion/reglas.json');

const igual = (a: unknown, b: unknown) =>
  (typeof a === 'number' || a == null) && (typeof b === 'number' || b == null)
    ? (a ?? NaN) === (b ?? NaN) || (Number.isNaN(a ?? NaN) && Number.isNaN(b ?? NaN))
    : a === b;

let fallas = 0;
function comparar(nombre: string, ref: any[], ts: any[], campos: string[]) {
  let malas = 0;
  if (ref.length !== ts.length) { console.log(`  ${nombre}: largo ref ${ref.length} vs ts ${ts.length}`); malas++; }
  for (let i = 0; i < Math.min(ref.length, ts.length); i++) {
    const c = campos.find((k) => !igual(ref[i][k], ts[i][k]));
    if (c !== undefined) {
      if (malas < 5) console.log(`  ${nombre}[${i}] ${c}: ref=${JSON.stringify(ref[i][c])} ts=${JSON.stringify(ts[i][c])} (OS ${ref[i].OS ?? ref[i]['O/S']})`);
      malas++;
    }
  }
  console.log(`  ${nombre.padEnd(18)} ${ref.length} filas  ${malas ? `✗ ${malas} distintas` : '✓ idénticas'}`);
  fallas += malas;
}

for (const caso of ['tecnika', 'clinical']) {
  const ref = leer(`motor/regresion/ref_${caso}.json`);
  const csv = ref.csv.includes('Tecnika') ? 'Tecnika/O_S_SIN_FACTURAR_28OCT2026.csv' : 'Clinical Market/O_S_SIN_FACTURAR_29OCT2026.csv';
  const t0 = performance.now();
  const r = procesar(leerCsv(readFileSync(join(dir, csv), 'utf8')), erp, reglas);
  console.log(`${caso}: ${(performance.now() - t0).toFixed(0)} ms`);
  comparar('OS', ref.os, r.filas, Object.keys(ref.os[0]));
  comparar('ajustes', ref.ajustes, r.ajustes, ['OS', 'Campo', 'Valor_ERP', 'Valor_corregido', 'Regla']);
  comparar('observadas', ref.observadas, r.observadas, ['OS', 'Regla', 'Detalle']);
  comparar('propuestas', ref.propuestas, r.propuestas, Object.keys(ref.propuestas[0] ?? {}));
  comparar('propuestas detalle', ref.propuestas_detalle, r.detalle, Object.keys(ref.propuestas_detalle[0] ?? {}));
}
console.log(fallas ? `\nREGRESIÓN FALLA: ${fallas} diferencias` : '\nREGRESIÓN OK: motor TS idéntico a motor.py');
process.exitCode = fallas ? 1 : 0;

// ---------------------------------------------------------------- R01 Sorter (no existe en motor.py: se prueba aparte)
import { existsSync } from 'node:fs';
if (existsSync(join(dir, 'carga_erp/sorter.json'))) {
  const sorter = new Map<string, { largo: number; ancho: number; alto: number }[]>();
  for (const b of filas('sorter')) {
    if (!sorter.has(b.os)) sorter.set(b.os, []);
    sorter.get(b.os)!.push({ largo: b.largo, ancho: b.ancho, alto: b.alto });
  }
  console.log('\nR01 Sorter:');
  for (const [caso, csv] of [['tecnika', 'Tecnika/O_S_SIN_FACTURAR_28OCT2026.csv'], ['clinical', 'Clinical Market/O_S_SIN_FACTURAR_29OCT2026.csv']]) {
    const base = leerCsv(readFileSync(join(dir, csv), 'utf8'));
    const sin = procesar(base, erp, reglas), con = procesar(base, { ...erp, sorter }, reglas);
    const neto = (r: any) => r.filas.reduce((a: number, f: any) => a + f['Total Neto'], 0);
    const enCero = (r: any) => r.observadas.filter((o: any) => o.Detalle.startsWith('Medidas en cero')).length;
    const completadas = new Set(con.ajustes.filter((a) => a.Regla.startsWith('R01 Sorter')).map((a) => a.OS)).size;
    console.log(`  ${caso}: "Medidas en cero" ${enCero(sin)} -> ${enCero(con)} | OS completadas ${completadas} | neto ${neto(sin)} -> ${neto(con)}`);
    if (enCero(sin) - enCero(con) !== completadas) { console.log('  ✗ las observaciones no bajan en lo completado'); fallas++; }
  }
  const r = procesar(leerCsv(readFileSync(join(dir, 'Clinical Market/O_S_SIN_FACTURAR_29OCT2026.csv'), 'utf8')), { ...erp, sorter }, reglas);
  const os = r.filas.find((f) => f['O/S'] === '202085790')!;
  const ok = os['KG.V'] === 13 && os.Largo === 31 && os.Ancho === 23 && os.Alto === 32
    && r.ajustes.some((a) => a.OS === '202085790' && a.Regla === 'R01 Sorter (7 bultos)');
  console.log(`  OS 202085790: KG.V ${os['KG.V']}, ${os.Largo}x${os.Ancho}x${os.Alto} ${ok ? '✓' : '✗'}`);
  if (!ok) fallas++;
  console.log(fallas ? 'SORTER FALLA' : 'SORTER OK');
  process.exitCode = fallas ? 1 : 0;
}
