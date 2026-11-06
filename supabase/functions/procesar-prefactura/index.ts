// Procesa un CSV "O/S sin facturar": valida cartera, tarifica con la última carga ERP y las reglas del cliente,
// y guarda lote, OS, ajustes, observaciones e impacto de propuestas. El CSV original queda en Storage.
// Llamada: POST con el archivo como cuerpo, headers Authorization (sesión del usuario) y x-archivo (nombre).
// Con x-simular: 1 solo devuelve resumen e impacto de propuestas, sin guardar.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { leerCsv, procesar } from './motor.ts';
import type { Erp, Regla, Tramos } from './motor.ts';

const URL_SB = Deno.env.get('SUPABASE_URL')!;
const db = createClient(URL_SB, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-archivo, x-simular, x-rut',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const resp = (cuerpo: unknown, status = 200) => Response.json(cuerpo, { status, headers: CORS });
const MAX_BYTES = 20 * 1024 * 1024;

async function todo<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {   // PostgREST entrega máximo 1000 filas por consulta
    const { data, error } = await consulta(i, i + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

function decodificar(b: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); }   // el ERP exporta en ISO-8859
}

async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return resp({ error: 'Usar POST' }, 405);

  // usuario y perfil
  const usuario = createClient(URL_SB, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await usuario.auth.getUser();
  if (!user) return resp({ error: 'Sesión no válida' }, 401);
  const { data: perfil } = await db.from('perfiles').select('activo').eq('user_id', user.id).maybeSingle();
  if (!perfil?.activo) return resp({ error: 'Usuario sin perfil activo en la plataforma' }, 403);

  // archivo
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return resp({ error: 'Archivo vacío o mayor a 20 MB' }, 400);
  let archivo = req.headers.get('x-archivo') ?? 'os_sin_facturar.csv';
  try { archivo = decodeURIComponent(archivo); } catch { /* nombre sin codificar */ }
  archivo = archivo.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]/g, '_').slice(0, 120);
  let base;
  try { base = leerCsv(decodificar(bytes)); } catch { return resp({ error: 'No se pudo leer el CSV' }, 400); }
  if (!base.length || !('Rut Cliente' in base[0])) return resp({ error: 'El archivo no es un "O/S sin facturar" del ERP' }, 400);
  const ruts = [...new Set(base.map((r) => r['Rut Cliente']))];
  if (ruts.length !== 1) return resp({ error: `El archivo debe traer un solo cliente; trae ${ruts.join(', ')}` }, 400);
  const rut = ruts[0];
  const esperado = req.headers.get('x-rut');
  if (esperado && esperado !== rut) return resp({ error: `El archivo es del RUT ${rut}, no del cliente seleccionado (${esperado})` }, 400);

  // R00 cartera: la RLS del usuario decide si ve el cliente
  const { data: cliente } = await usuario.from('clientes').select('rut, razon_social, ejecutivo_erp').eq('rut', rut).maybeSingle();
  if (!cliente) return resp({ error: `El cliente ${rut} no está en su cartera` }, 403);

  try {
    // última carga ERP de cada tipo
    const { data: cargas, error: e1 } = await db.from('erp_cargas').select('id, tipo').order('id', { ascending: false });
    if (e1) throw e1;
    const carga: Record<string, number> = {};
    for (const c of cargas ?? []) carga[c.tipo] ??= c.id;
    const faltan = ['SUCURSALES', 'CONTRATOS', 'TARIFAS', 'SERVICIOS'].filter((t) => !carga[t]);
    if (faltan.length) return resp({ error: `Faltan tablas ERP: ${faltan.join(', ')}` }, 409);

    const sucursales = await todo((a, b) => db.from('erp_sucursales').select('clie_rut, suc_nro, suc_nombre')
      .eq('carga_id', carga.SUCURSALES).eq('clie_rut', rut).range(a, b));
    const contratos = await todo((a, b) => db.from('erp_contratos')
      .select('clie_rut, suc_nro, convenio, recargo_t, recargo_a, peso_facturacion')
      .eq('carga_id', carga.CONTRATOS).eq('clie_rut', rut).order('fila').range(a, b));
    const convenios = [...new Set(contratos.map((c: any) => c.convenio))];
    const tarifas = convenios.length ? await todo((a, b) => db.from('erp_tarifas')
      .select('convenio, servicio, via, origen, destino, tramos')
      .eq('carga_id', carga.TARIFAS).in('convenio', convenios).order('convenio').order('servicio').order('via')
      .order('origen').order('destino').range(a, b)) : [];
    const servicios = await todo((a, b) => db.from('erp_servicios').select('nombre, codigo').eq('carga_id', carga.SERVICIOS).range(a, b));
    const ciudades = await todo((a, b) => db.from('ciudades').select('nombre, codigo').range(a, b));
    const reglas = await todo<Regla>((a, b) => db.from('reglas').select('*').eq('rut', rut)
      .in('estado', ['VIGENTE', 'PROPUESTA']).order('id').range(a, b));

    // sorter: bultos de las OS del archivo (tabla acumulativa; si un bulto se cargó dos veces vale la carga más reciente)
    const oss = [...new Set(base.map((r) => String(r['O/S'])))];
    const bultos = new Map<string, Map<number, any>>();
    for (let i = 0; i < oss.length; i += 200) {
      const filas = await todo((a, b) => db.from('erp_sorter').select('carga_id, os, nbulto, largo, ancho, alto')
        .in('os', oss.slice(i, i + 200)).order('os').order('nbulto').order('carga_id').range(a, b));
      for (const f of filas as any[]) {
        const m = bultos.get(f.os) ?? new Map();
        if (!m.has(f.nbulto) || f.carga_id > m.get(f.nbulto).carga_id) m.set(f.nbulto, f);
        bultos.set(f.os, m);
      }
    }
    const sorter = new Map([...bultos].map(([os, m]) => [os, [...m.values()]
      .map((f) => ({ largo: Number(f.largo), ancho: Number(f.ancho), alto: Number(f.alto) }))]));

    const erp: Erp = {
      sorter,
      sucursales: sucursales as Erp['sucursales'],
      contratos: contratos as Erp['contratos'],
      tarifas: new Map(tarifas.map((t: any) => [`${t.convenio}|${t.servicio}|${t.via}|${t.origen}|${t.destino}`, t.tramos as Tramos])),
      servicios: new Map(servicios.map((s: any) => [s.nombre, s.codigo])),
      ciudades: new Map(ciudades.map((c: any) => [c.nombre, c.codigo])),
      ejecutivos: new Map([[rut, (cliente.ejecutivo_erp ?? '').toUpperCase()]]),
    };

    let r;
    try { r = procesar(base, erp, reglas); } catch (e) { return resp({ error: (e as Error).message }, 400); }

    const netoErp = base.reduce((a, x) => a + (isNaN(x['Total Neto']) ? 0 : x['Total Neto']), 0);
    const netoPref = r.filas.reduce((a, x) => a + x['Total Neto'], 0);
    const resumen = {
      cliente: `${rut} ${cliente.razon_social}`,
      os_archivo: r.filas.length,
      os_cobrables: r.filas.filter((f) => !String(f.Servicio ?? '').startsWith('LIBRE')).length,
      os_con_ajuste: new Set(r.ajustes.map((a) => a.OS)).size,
      os_observadas: new Set(r.observadas.map((o) => o.OS)).size,
      os_pendientes: r.filas.filter((f) => f.Estado === 'PENDIENTE').length,
      reglas_vigentes: r.vigentes.length,
      reglas_propuesta: r.enPropuesta.length,
      neto_erp: netoErp,
      neto_prefactura: netoPref,
      diferencia: netoPref - netoErp,
      neto_con_propuestas: (r.propuestas.find((p) => p.Regla === 'TODAS')?.Neto_con_regla as number) ?? netoPref,
    };

    // simular: impacto de las reglas sin guardar nada (pantalla de reglas)
    if (req.headers.get('x-simular') === '1') return resp({ resumen, propuestas: r.propuestas, detalle: r.detalle });

    // guardar: archivo, lote y detalle (si algo falla se borra el lote completo)
    const loteId = crypto.randomUUID();
    const ruta = `${rut}/${loteId}/${archivo}`;
    const up = await db.storage.from('cargas').upload(ruta, bytes, { contentType: 'text/csv' });
    if (up.error) throw up.error;
    const sinFecha = ({ _fecha, ...f }: Record<string, unknown>) => f;
    const { error: e2 } = await db.from('lotes').insert({
      id: loteId, rut, ejecutivo_id: user.id, archivo, archivo_path: ruta, columnas: Object.keys(base[0]).filter((c) => c !== '_fecha'), sha256: await sha256(bytes), estado: 'PROCESADO',
      erp_cargas_usadas: carga, reglas_usadas: { vigentes: r.vigentes, propuestas: r.enPropuesta },
      n_os: r.filas.length, total_neto_erp: netoErp, total_neto_pref: netoPref, procesado_en: new Date().toISOString(),
      propuestas: { resumen: r.propuestas, detalle: r.detalle },
    });
    if (e2) { await db.storage.from('cargas').remove([ruta]); throw e2; }

    const lotes: [string, Record<string, unknown>[]][] = [
      ['lote_os', r.filas.map((f, i) => ({
        lote_id: loteId, n: i, os: f['O/S'], estado: f.Estado, fila_erp: sinFecha(base[i]), fila_pref: sinFecha(f),
        total_neto_erp: base[i]['Total Neto'], total_neto_pref: f['Total Neto'],
      }))],
      ['lote_ajustes', r.ajustes.map((a) => ({
        lote_id: loteId, os: a.OS, campo: a.Campo, valor_erp: a.Valor_ERP, valor_corregido: a.Valor_corregido, regla: a.Regla,
      }))],
      ['lote_observaciones', r.observadas.map((o) => ({ lote_id: loteId, os: o.OS, regla: o.Regla, detalle: o.Detalle }))],
    ];
    for (const [tabla, filas] of lotes) {
      for (let i = 0; i < filas.length; i += 500) {
        // JSON convierte NaN en null: los valores vacíos del ERP quedan como null
        const { error } = await db.from(tabla).insert(filas.slice(i, i + 500));
        if (error) {
          await db.from('lotes').delete().eq('id', loteId);
          await db.storage.from('cargas').remove([ruta]);
          throw error;
        }
      }
    }
    return resp({ lote_id: loteId, resumen });
  } catch (e) {
    console.error(e);
    return resp({ error: 'Error interno al procesar', detalle: (e as { message?: string }).message ?? String(e) }, 500);
  }
});
