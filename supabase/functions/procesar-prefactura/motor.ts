// Motor de prefactura v0.3 — port fiel de motor.py (Newtrans).
// Puro: sin red ni base de datos. Lo usan la Edge Function y la prueba de regresión.

export const FACTOR_VOL = 4000;
export const IVA = 0.19;
export const LADO_MAX_CM = 250;
const VIA: Record<string, string> = { TERRESTRE: '1403', AEREA: '1401' };
const PESO: Record<string, string> = { '4014': 'FISICO', '4015': 'VOLUMETRICO', '4016': 'AMBOS' };
const NUM = ['Nro Piezas', 'Largo', 'Ancho', 'Alto', 'Valor Transporte', 'Valor Seguro', 'Valor Extra',
  'Valor Doc. Retorno', 'Total Neto', 'Iva', 'Total'];

export type Tramos = [number, number][];
export type Fila = Record<string, any>;
export interface Contrato {
  clie_rut: string; suc_nro: string; convenio: string;
  recargo_t: number | null; recargo_a: number | null; peso_facturacion: string | null;
}
export interface Erp {
  sucursales: { clie_rut: string; suc_nro: string; suc_nombre: string }[];
  contratos: Contrato[];               // en orden del export: se toma el primero que calce
  tarifas: Map<string, Tramos>;        // convenio|servicio|via|origen|destino
  servicios: Map<string, string>;      // nombre -> código 13xx
  ciudades: Map<string, string>;       // nombre -> código
  ejecutivos: Map<string, string>;     // rut -> ejecutivo del maestro
  sorter?: Map<string, Bulto[]>;       // O/S -> bultos medidos en el sorter (opcional)
}
export interface Bulto { largo: number; ancho: number; alto: number }
export interface Regla {
  codigo: string; rut: string; tipo: string; estado: string; servicio: string | null; via: string | null;
  desde: string | null; hasta: string | null; palabra: string | null; excluir: string | null;
  modo: string | null; condicion: string | null; largo: number | null; ancho: number | null; alto: number | null;
  valor: number | null; valor_txt: string | null; min_neto: number | null; max_neto: number | null; nota: string | null;
}
export interface Ajuste { OS: string; Campo: string; Valor_ERP: number; Valor_corregido: number; Regla: string }
export interface Observacion { OS: string; Regla: string; Detalle: string }

// ---------------------------------------------------------------- utilidades (mismo comportamiento que Python)
const py = (x: unknown) => (x == null || (typeof x === 'number' && isNaN(x)) ? 'nan' : String(x));
const nan = (x: number | null) => (x == null ? NaN : Number(x));
const txt = (g: Regla) => g.valor_txt ?? py(g.valor);   // Valor como texto (PESO, SERVICIO)

export function norm(s: unknown) {
  return py(s).toUpperCase().replace(/\s+/g, '').replaceAll(',', '.');
}
export function contiene(texto: unknown, palabras: string | null) {
  if (typeof palabras !== 'string') return false;
  const t = norm(texto);
  return norm(palabras).split('|').some((p) => p !== '' && t.includes(p));
}
/** Igual que el ERP: primero a 1 decimal, luego 0,5 hacia arriba. */
export function redondear(x: number) {
  return Math.floor(Number(x.toFixed(1)) + 0.5);
}
function mitadPar(x: number) {   // round() de Python
  const f = Math.floor(x), d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}
const miles = (x: number) => isNaN(x) ? 'nan' : (x < 0 ? '-' : '') + String(Math.abs(mitadPar(x))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const f0 = (x: number) => isNaN(x) ? 'nan' : String(mitadPar(x));
function g6(x: number) {   // formato :g de Python
  if (isNaN(x)) return 'nan';
  const p = Number(x.toPrecision(6));
  if (p !== 0 && (Math.abs(p) >= 1e6 || Math.abs(p) < 1e-4)) {
    const [m, e] = p.toExponential().split('e');
    return `${Number(Number(m).toPrecision(6))}e${Number(e) < 0 ? '-' : '+'}${String(Math.abs(Number(e))).padStart(2, '0')}`;
  }
  return String(p);
}
const pyMax = (a: number, b: number) => (b > a ? b : a);
const distinto = (a: unknown, b: unknown) => a == null || b == null || a !== b;   // NaN != NaN en Python

export function precio(tramos: Tramos, via: string, kg: number, piezas: number) {
  if (tramos[0][0] === 1 && new Set(tramos.map((t) => t[1])).size === 1) return tramos[0][1] * piezas;  // por pieza
  const i = tramos.findIndex(([h]) => kg <= h);
  if (i < 0) throw new Error(`peso ${kg} fuera de los tramos`);
  if (via === 'AEREA') return i === 0 ? tramos[0][1] : tramos[0][1] + (kg - tramos[0][0]) * tramos[i][1];
  let ult = -1;
  tramos.forEach(([h], j) => { if (h <= 100) ult = j; });   // hasta 100 kg montos fijos
  if (ult < 0) throw new Error('tarifa sin tramo ≤ 100 kg');
  return i <= ult ? tramos[i][1] : tramos[ult][1] + (kg - 100) * tramos[i][1];
}

// ---------------------------------------------------------------- lectura del CSV "O/S sin facturar"
function partirCsv(t: string): string[][] {
  const out: string[][] = [];
  let fila: string[] = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c !== '"') f += c;
      else if (t[i + 1] === '"') { f += '"'; i++; }
      else q = false;
    } else if (c === '"' && f === '') q = true;
    else if (c === ';') { fila.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(f); out.push(fila); fila = []; f = '';
    } else f += c;
  }
  if (f !== '' || fila.length) { fila.push(f); out.push(fila); }
  return out.filter((r) => r.length > 1 || r[0] !== '');
}
const aNumero = (s: string | null) => (s == null || s.trim() === '' ? NaN : Number(s));

export function leerCsv(texto: string): Fila[] {
  const [cab, ...filas] = partirCsv(texto);
  const cols = cab.map((c) => (c.startsWith('Descrip') ? 'Descripcion' : c));
  const vacias = new Set(cols.filter((_, j) => filas.every((r) => (r[j] ?? '') === '')));
  return filas.map((r) => {
    const o: Fila = {};
    cols.forEach((c, j) => { if (!vacias.has(c)) o[c] = r[j] == null || r[j] === '' ? null : r[j]; });
    for (const c of NUM) o[c] = aNumero(o[c] == null ? null : String(o[c]).replaceAll('.', '').replaceAll(',', '.'));
    for (const c of ['KG.F', 'KG.V']) o[c] = aNumero(o[c] == null ? null : String(o[c]).replaceAll(',', '.'));
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(o['Fecha O/S'] ?? '');
    o._fecha = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    return o;
  });
}

// ---------------------------------------------------------------- cálculo
function aplica(g: Regla, r: Fila) {
  return g.rut === r['Rut Cliente']
    && (g.servicio == null || norm(r.Servicio).includes(norm(g.servicio)))
    && (g.via == null || g.via.trim().toUpperCase() === r.Via)
    && (g.desde == null || (r._fecha != null && r._fecha >= g.desde))
    && (g.hasta == null || (r._fecha != null && r._fecha <= g.hasta));
}

export function calcular(base: Fila[], erp: Erp, reglas: Regla[]) {
  const df = base.map((r) => ({ ...r }));
  const aj: Ajuste[] = [], ob: Observacion[] = [];
  const contratos = new Map<string, Contrato | null>();
  const pendientes = new Set<number>();
  const transp = new Map<number, Regla[]>();   // OS tarificadas -> reglas que aplican

  for (let i = 0; i < base.length; i++) {
    const r = base[i], d = df[i], os = r['O/S'];
    const ajuste = (campo: string, nuevo: number, regla: string) => {
      const antes = d[campo];
      if (antes !== nuevo) { aj.push({ OS: os, Campo: campo, Valor_ERP: antes, Valor_corregido: nuevo, Regla: regla }); d[campo] = nuevo; }
    };
    const observa = (regla: string, detalle: string) => ob.push({ OS: os, Regla: regla, Detalle: detalle });

    const rut = r['Rut Cliente'], razon = py(r['Razon Social']).trim(), clave = `${rut}|${razon}`;
    if (!contratos.has(clave)) {
      const sucs = new Set(erp.sucursales.filter((s) => s.clie_rut === rut && s.suc_nombre === razon).map((s) => s.suc_nro));
      contratos.set(clave, erp.contratos.find((c) => c.clie_rut === rut && sucs.has(c.suc_nro)) ?? null);
    }
    const k = contratos.get(clave)!;
    const ej = erp.ejecutivos.get(rut);
    if (ej === undefined) observa('R00 Cliente', 'RUT no está en el maestro de clientes 2026');
    else if (ej !== py(r['Ejecutivo Vta']).trim().toUpperCase()) observa('R00 Ejecutivo', `ERP: ${py(r['Ejecutivo Vta'])} / maestro: ${ej}`);
    if (k === null) {
      observa('R00 Contrato', `Sin contrato para ${razon}`);
      pendientes.add(i);
      continue;
    }
    if (py(r.Servicio).startsWith('LIBRE')) continue;
    const rr = reglas.filter((g) => aplica(g, r));

    if (rr.some((g) => g.tipo === 'EXIMIR' && (contiene(r.Descripcion, g.palabra) || contiene(r.Servicio, g.palabra)))) {
      ajuste('Valor Transporte', 0, 'EXIMIR');
      continue;
    }

    // MEDIDAS (primera regla que calza)
    let kgv: number = r['KG.V'];
    const gm = rr.find((g) => g.tipo === 'MEDIDAS' && contiene(r.Descripcion, g.palabra) && !contiene(r.Descripcion, g.excluir));
    if (gm) {
      const n = gm.modo === 'POR_PIEZA' ? r['Nro Piezas'] : 1;
      const nuevo = Math.ceil(n * nan(gm.largo) * nan(gm.ancho) * nan(gm.alto) / FACTOR_VOL - 1e-9);
      if (!(gm.condicion === 'SOLO_SI_BAJA' && nuevo >= kgv)) {
        for (const [campo, v] of [['Largo', gm.largo], ['Ancho', gm.ancho], ['Alto', gm.alto], ['KG.V', nuevo]] as [string, number][]) {
          ajuste(campo, v, `${gm.codigo} MEDIDAS`);
        }
        kgv = nuevo;
      }
    } else {
      const sorter = erp.sorter?.get(String(os));
      const sinMedidas = [r.Largo, r.Ancho, r.Alto].includes(0);
      if (sinMedidas && sorter && sorter.length >= r['Nro Piezas']) {
        // R01 Sorter: medidas del bulto mayor y KG.V con la suma de todos los bultos (igual que el ERP)
        const v = (b: Bulto) => b.largo * b.ancho * b.alto;
        const mayor = sorter.reduce((a, b) => (v(b) > v(a) ? b : a));
        const nuevo = Math.ceil(sorter.reduce((s, b) => s + v(b), 0) / FACTOR_VOL - 1e-9);
        const regla = `R01 Sorter (${sorter.length} bultos)`;
        ajuste('Largo', mayor.largo, regla);
        ajuste('Ancho', mayor.ancho, regla);
        ajuste('Alto', mayor.alto, regla);
        ajuste('KG.V', nuevo, regla);
        kgv = nuevo;
      } else {
        if (sinMedidas) {
          observa('R01 Medidas', sorter ? `Medidas en cero; el sorter midió ${sorter.length} de ${r['Nro Piezas']} bultos` : 'Medidas en cero');
        } else if (Math.max(r.Largo, r.Ancho, r.Alto) > LADO_MAX_CM) {
          observa('R01 Medidas', `Lado > ${LADO_MAX_CM} cm: ${f0(r.Largo)}x${f0(r.Ancho)}x${f0(r.Alto)}`);
        }
        const calc = Math.ceil(r.Largo * r.Ancho * r.Alto / FACTOR_VOL - 1e-9);
        if (calc !== kgv) observa('R01 KG.V', `KG.V ERP ${g6(kgv)} ≠ L×A×H/4000 = ${calc}; se respeta ERP`);
      }
    }

    const gp = rr.find((g) => g.tipo === 'PESO');
    const modo = gp ? txt(gp).trim().toUpperCase() : PESO[k.peso_facturacion ?? ''] ?? 'AMBOS';
    const kg = modo === 'FISICO' ? r['KG.F'] : modo === 'VOLUMETRICO' ? kgv : pyMax(r['KG.F'], kgv);

    const orig = py(r.Servicio).split(' - ')[0].trim();
    const gs = rr.find((g) => g.tipo === 'SERVICIO' && norm(orig).includes(norm(g.servicio)));
    const nombre = gs ? txt(gs).trim().toUpperCase() : orig;
    const cod = erp.servicios.get(nombre);
    const o = erp.ciudades.get(r.Origen), de = erp.ciudades.get(r.Destino);
    const clv = `${k.convenio}|${cod}|${VIA[r.Via]}`;
    const t1 = erp.tarifas.get(`${clv}|${o}|${de}`);
    const tramos = t1?.length ? t1 : erp.tarifas.get(`${clv}|${de}|${o}`);   // R05 espejo
    const vt: number = r['Valor Transporte'];
    if (!tramos?.length) {
      const motivo = o === undefined || de === undefined
        ? `Ciudad sin código: ${py(o === undefined ? r.Origen : r.Destino)}`
        : `Convenio ${k.convenio} sin tramo ${nombre} (${cod ?? 'None'}) ${py(r.Via)} ${py(r.Origen)}-${py(r.Destino)}`;
      if (vt > 0) observa('R03 Sin tarifa', `${motivo}; se respeta valor ERP ${miles(vt)}`);
      else { observa('R03 Sin tarifa', `${motivo}; OS PENDIENTE, no se prefactura`); pendientes.add(i); }
      continue;
    }

    const rec = rr.find((g) => g.tipo === 'RECARGO');
    const pct = rec ? nan(rec.valor) : nan(r.Via === 'AEREA' ? k.recargo_a : k.recargo_t);
    const conRec = distinto(r.Secundario, r.Destino) && (!rec || rec.palabra == null || contiene(r.Secundario, rec.palabra));
    let bruto: number;
    try { bruto = precio(tramos, r.Via, kg, r['Nro Piezas']); }
    catch (e) {   // en Python detenía todo el archivo; aquí queda la OS pendiente
      observa('R03 Sin tarifa', `${(e as Error).message}; OS PENDIENTE, no se prefactura`);
      pendientes.add(i);
      continue;
    }
    const esperado = redondear(bruto * (conRec ? 1 + pct / 100 : 1));
    const cambioRegla = kgv !== r['KG.V'] || nombre !== orig;
    if (vt > 0 && esperado !== vt && r.Destino === 'SANTIAGO' && !cambioRegla) {
      // ponytail: en retiros (región -> SCL) el ERP aplica el recargo de forma irregular; se observa, no se corrige
      observa('R03 Tarifa retiro', `ERP ${miles(vt)} / motor ${miles(esperado)} (recargo de comuna en retiro)`);
    } else {
      ajuste('Valor Transporte', esperado, vt <= 0 ? 'R05 Tarifa espejo' : 'R03 Tarifa');
    }
    transp.set(i, rr);
  }

  // DESCUENTO, CARGO_FIJO, COMBUSTIBLE (después de tarificar)
  let total = 0;
  for (const i of transp.keys()) { const v = df[i]['Valor Transporte']; if (!isNaN(v)) total += v; }
  for (const [i, rr] of transp) {
    const d = df[i], piezas = d['Nro Piezas'];
    const ajuste = (campo: string, nuevo: number, regla: string) => {
      aj.push({ OS: d['O/S'], Campo: campo, Valor_ERP: d[campo], Valor_corregido: nuevo, Regla: regla });
      d[campo] = nuevo;
    };
    for (const g of rr) {
      const mn = nan(g.min_neto), mx = nan(g.max_neto);
      if (g.tipo === 'DESCUENTO' && g.valor && (isNaN(mn) || (mn <= total && total <= mx))) {
        ajuste('Valor Transporte', redondear(d['Valor Transporte'] * (1 - g.valor / 100)), `${g.codigo} DESCUENTO ${g6(g.valor)}%`);
      }
    }
    let extra = 0;
    for (const g of rr) {
      if (g.tipo === 'CARGO_FIJO') extra += nan(g.valor) * (g.modo === 'POR_PIEZA' ? piezas : 1);
      else if (g.tipo === 'COMBUSTIBLE') extra += redondear(d['Valor Transporte'] * nan(g.valor) / 100);
    }
    if (extra) {
      const ids = rr.filter((g) => g.tipo === 'CARGO_FIJO' || g.tipo === 'COMBUSTIBLE').map((g) => g.codigo).join('+');
      ajuste('Valor Extra', d['Valor Extra'] + extra, `${ids} EXTRA`);
    }
  }

  // R12 cuadratura
  const suma = (...v: number[]) => v.reduce((a, x) => (isNaN(x) ? a : a + x), 0);
  df.forEach((d, i) => { d.Estado = pendientes.has(i) ? 'PENDIENTE' : 'PREFACTURA'; });
  const neto = df.map((d) => d.Estado === 'PENDIENTE' ? 0
    : suma(d['Valor Transporte'], d['Valor Seguro'], d['Valor Extra'], d['Valor Doc. Retorno']));
  const iva = neto.map((n) => redondear(n * IVA));
  for (const [campo, nuevo] of [['Total Neto', neto], ['Iva', iva], ['Total', neto.map((n, i) => n + iva[i])]] as [string, number[]][]) {
    df.forEach((d, i) => {
      if (d[campo] !== nuevo[i]) aj.push({ OS: d['O/S'], Campo: campo, Valor_ERP: d[campo], Valor_corregido: nuevo[i], Regla: 'R12 Cuadratura' });
    });
    df.forEach((d, i) => { d[campo] = nuevo[i]; });
  }
  return { filas: df, ajustes: aj, observadas: ob };
}

/** Prefactura con reglas VIGENTE + impacto de cada regla PROPUESTA (y de todas juntas). */
export function procesar(base: Fila[], erp: Erp, reglas: Regla[]) {
  const ruts = [...new Set(base.map((r) => r['Rut Cliente']))];
  if (ruts.length !== 1) throw new Error(`El archivo debe traer un solo cliente; trae ${ruts.join(', ')}`);
  const rg = reglas.filter((g) => g.rut === ruts[0]);
  const vig = rg.filter((g) => g.estado === 'VIGENTE'), prop = rg.filter((g) => g.estado === 'PROPUESTA');
  const res = calcular(base, erp, vig);
  const netoDe = (f: Fila[]) => f.reduce((a, x) => a + x['Total Neto'], 0);
  const propuestas: Record<string, unknown>[] = [], detalle: Record<string, unknown>[] = [];
  if (prop.length) {
    const casos: [string, Regla[]][] = [...prop.map((g) => [g.codigo, prop.filter((x) => x.codigo === g.codigo)] as [string, Regla[]]), ['TODAS', prop]];
    for (const [nombre, extra] of casos) {
      const alt = calcular(base, erp, [...vig, ...extra]).filas;
      const dif = res.filas.map((f, i) => alt[i]['Total Neto'] - f['Total Neto']);
      propuestas.push({
        Regla: nombre,
        Descripcion: nombre === 'TODAS' ? 'Todas las propuestas juntas' : `${extra[0].tipo} ${extra[0].nota ?? ''}`,
        OS_afectadas: dif.filter((x) => x !== 0).length,
        Neto_prefactura: netoDe(res.filas), Neto_con_regla: netoDe(alt), Diferencia: dif.reduce((a, x) => a + x, 0),
      });
      if (nombre === 'TODAS') continue;
      dif.forEach((x, i) => {
        if (x === 0) return;
        const a = res.filas[i], b = alt[i], fila: Record<string, unknown> = { Regla: nombre, OS: a['O/S'], Descripcion: a.Descripcion };
        for (const c of ['KG.V', 'Valor Transporte', 'Valor Extra', 'Total Neto']) fila[`${c} actual`] = a[c];
        for (const c of ['KG.V', 'Valor Transporte', 'Valor Extra', 'Total Neto']) fila[`${c} con regla`] = b[c];
        fila.Diferencia_neto = x;
        detalle.push(fila);
      });
    }
  }
  return { ...res, propuestas, detalle, vigentes: vig, enPropuesta: prop };
}
