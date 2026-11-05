'use strict';
// Plataforma de Prefactura Newtrans — SPA sobre Supabase (proyecto newtrans - prefactura).
// La seguridad la imponen RLS y la Edge Function; esta pantalla solo muestra lo que el usuario puede ver.

const SB_URL = 'https://jewozfxtofbkljcwowmh.supabase.co';
const SB_KEY = 'sb_publishable_gVghVASl3topBu4Y2TGECQ_5q66K6mq';   // clave publicable (pública por diseño)
const enlace = new URLSearchParams(location.hash.slice(1));          // invitación / recuperación de contraseña
const sb = supabase.createClient(SB_URL, SB_KEY);

// ---------------------------------------------------------------- utilidades
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtN = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? '' : fmtN.format(x));
const pesos = (x) => (x == null ? '' : `${x < 0 ? '-' : ''}$${fmtN.format(Math.abs(Math.round(x)))}`);
const fecha = (s) => (s ? new Date(s).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const signo = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const hoy = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const ROLES = { ejecutivo: 'Ejecutivo comercial', jefatura: 'Jefatura comercial', admin: 'Administrador' };
const MAX_FILAS = 1000;   // filas visibles en pantalla; el informe Excel trae todas

const est = { perfil: null, clientes: [], cliente: null, tab: 'procesar', lote: null };
const esSup = () => ['jefatura', 'admin'].includes(est.perfil?.rol);

function vista(id) { for (const v of ['v-login', 'v-clave', 'v-app']) $(`#${v}`).classList.toggle('oculto', v !== id); }
function error(el, msg) { el.textContent = msg ?? ''; el.classList.toggle('oculto', !msg); }
function modal(html) { $('#i-contenido').innerHTML = html; $('#d-info').showModal(); }
$('#i-cerrar').onclick = () => $('#d-info').close();

async function todo(consulta) {   // PostgREST entrega máximo 1000 filas por consulta
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error: e } = await consulta(i, i + 999);
    if (e) throw e;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const tabla = (cab, filas) => `<div class="tabla"><table><thead><tr>${cab.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${filas.join('')}</tbody></table></div>`;

// ---------------------------------------------------------------- acceso
async function iniciar() {
  if (enlace.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    vista('v-login');
    return error($('#l-error'), `El enlace no es válido o expiró (${enlace.get('error_description')}). Pide una nueva invitación o usa “¿Olvidaste tu contraseña?”.`);
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session && ['invite', 'recovery', 'signup'].includes(enlace.get('type'))) {
    history.replaceState(null, '', location.pathname);
    return vista('v-clave');
  }
  if (session) return entrar();
  vista('v-login');
}
sb.auth.onAuthStateChange((evento) => {
  if (evento === 'PASSWORD_RECOVERY') vista('v-clave');
  if (evento === 'SIGNED_OUT') vista('v-login');
});

$('#f-login').onsubmit = async (e) => {
  e.preventDefault();
  error($('#l-error'));
  const { error: er } = await sb.auth.signInWithPassword({ email: $('#l-correo').value.trim(), password: $('#l-clave').value });
  if (er) return error($('#l-error'), er.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : er.message);
  entrar();
};
$('#b-olvide').onclick = async () => {
  const email = $('#l-correo').value.trim();
  if (!email) return error($('#l-error'), 'Escribe tu correo y vuelve a presionar “¿Olvidaste tu contraseña?”.');
  const { error: er } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  error($('#l-error'), er ? er.message : `Si ${email} tiene acceso, recibirá un correo para crear una nueva contraseña.`);
};
$('#f-clave').onsubmit = async (e) => {
  e.preventDefault();
  if ($('#c-1').value !== $('#c-2').value) return error($('#c-error'), 'Las contraseñas no coinciden.');
  const { error: er } = await sb.auth.updateUser({ password: $('#c-1').value });
  if (er) return error($('#c-error'), er.message);
  entrar();
};
$('#b-salir').onclick = () => sb.auth.signOut();
$('#b-maestro').onclick = () => {
  $('#d-info').classList.add('ancho');
  modal(`<h2>Maestro de reglas del sistema</h2><p class="aviso">Las aplica el motor a todos los clientes. Las reglas propias de cada cliente
    (ej. TEC-01) se ven en su pestaña “Reglas del cliente”.</p>` + tabla(['Id', 'Regla', 'Qué revisa', 'Qué hace', 'Estado'],
    est.rs.map((r) => `<tr><td class="mono"><b>${esc(r.id)}</b></td><td>${esc(r.nombre)}</td><td>${esc(r.logica)}</td>
      <td>${esc(r.accion)}</td><td><span class="chip ${esc(r.estado)}">${esc(r.estado)}</span></td></tr>`)));
  $('#d-info').addEventListener('close', () => $('#d-info').classList.remove('ancho'), { once: true });
};

/** Texto de ayuda para una etiqueta de regla del motor ("R03 Tarifa", "TEC-01 MEDIDAS", "CLM-03+CLM-05 EXTRA"). */
function explicar(etiqueta) {
  const id = /^R\d\d/.exec(etiqueta)?.[0];
  if (id) {
    const r = est.rs.find((x) => x.id === id);
    return r ? `${r.id} ${r.nombre}: ${r.logica} → ${r.accion}` : etiqueta;
  }
  if (etiqueta === 'EXIMIR') return 'Regla del cliente tipo EXIMIR: transporte en $0.';
  const usadas = [...(est.lote?.l.reglas_usadas?.vigentes ?? []), ...(est.lote?.l.reglas_usadas?.propuestas ?? [])];
  return etiqueta.split(' ')[0].split('+').map((c) => {
    const g = usadas.find((x) => x.codigo === c);
    return g ? `${c} (regla del cliente): ${parametros(g)}. Acuerdo: ${g.nota}` : c;
  }).join('\n');
}

async function entrar() {
  const { data: { user } } = await sb.auth.getUser();
  const { data: perfil } = await sb.from('perfiles').select('*').eq('user_id', user?.id).maybeSingle();
  if (!perfil?.activo) {
    await sb.auth.signOut();
    vista('v-login');
    return error($('#l-error'), 'Tu usuario no tiene acceso a la plataforma. Contacta al administrador.');
  }
  est.perfil = perfil;
  $('#yo-nombre').textContent = perfil.nombre;
  $('#yo-rol').textContent = ROLES[perfil.rol];
  vista('v-app');
  const { data } = await sb.from('clientes').select('rut, razon_social, ejecutivo_erp').order('razon_social');
  est.clientes = data ?? [];
  est.rs = (await sb.from('reglas_sistema').select('*').order('id')).data ?? [];
  pintarCartera();
}

// ---------------------------------------------------------------- cartera y cliente
function pintarCartera() {
  const q = $('#buscar').value.trim().toUpperCase();
  const lista = est.clientes.filter((c) => !q || c.razon_social.toUpperCase().includes(q) || c.rut.includes(q));
  $('#clientes').innerHTML = lista.map((c) => `<li><button data-rut="${esc(c.rut)}" class="${est.cliente?.rut === c.rut ? 'activo' : ''}">
    ${esc(c.razon_social)}<small>${esc(c.rut)}${esSup() ? ` · ${esc(c.ejecutivo_erp ?? 'sin ejecutivo')}` : ''}</small></button></li>`).join('')
    || '<li class="aviso">Sin clientes.</li>';
}
$('#buscar').oninput = pintarCartera;
$('#clientes').onclick = (e) => { const b = e.target.closest('[data-rut]'); if (b) abrirCliente(b.dataset.rut); };

function abrirCliente(rut, tab = 'procesar') {
  est.cliente = est.clientes.find((c) => c.rut === rut);
  est.tab = tab;
  pintarCartera();
  pintarCliente();
}

function pintarCliente() {
  const c = est.cliente;
  $('#panel').innerHTML = `<div class="cab"><div><h2>${esc(c.razon_social)}</h2>
    <div class="aviso">RUT ${esc(c.rut)} · Ejecutivo ${esc(c.ejecutivo_erp ?? '—')}</div></div></div>
    <div class="tabs">${[['procesar', 'Procesar archivo'], ['lotes', 'Procesos'], ['reglas', 'Reglas del cliente']]
      .map(([k, t]) => `<button data-tab="${k}" class="${est.tab === k ? 'activo' : ''}">${t}</button>`).join('')}</div>
    <div id="contenido"></div>`;
  $('#panel .tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { est.tab = b.dataset.tab; pintarCliente(); } };
  ({ procesar: tabProcesar, lotes: tabLotes, reglas: tabReglas })[est.tab]();
}

async function motor(archivo, nombre, simular = false) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(`${SB_URL}/functions/v1/procesar-prefactura`, {
    method: 'POST', body: archivo,
    headers: {
      Authorization: `Bearer ${session.access_token}`, apikey: SB_KEY, 'Content-Type': 'text/csv',
      'x-archivo': encodeURIComponent(nombre), 'x-rut': est.cliente.rut, ...(simular ? { 'x-simular': '1' } : {}),
    },
  });
  const j = await r.json().catch(() => ({ error: `Error ${r.status} del servidor` }));
  if (!r.ok) throw new Error(j.error + (j.detalle ? ` (${j.detalle})` : ''));
  return j;
}

// ---------------------------------------------------------------- procesar archivo
function tabProcesar() {
  $('#contenido').innerHTML = `<div class="subir" id="zona">
      <p><b>Sube el archivo “O/S sin facturar”</b> de ${esc(est.cliente.razon_social)}, exportado del ERP (CSV).</p>
      <input type="file" id="csv" accept=".csv,text/csv" style="max-width:340px">
      <p class="aviso">Se valida el cliente, se recalcula cada OS con las tarifas del ERP y se aplican las reglas vigentes.<br>
      Las reglas en propuesta no cambian la prefactura: solo se informa su impacto.</p>
      <button class="prim" id="b-procesar" disabled>Procesar</button></div>
    <div id="p-error" class="error oculto"></div>`;
  const inp = $('#csv'), zona = $('#zona'), b = $('#b-procesar');
  inp.onchange = () => { b.disabled = !inp.files.length; };
  zona.ondragover = (e) => { e.preventDefault(); zona.classList.add('sobre'); };
  zona.ondragleave = () => zona.classList.remove('sobre');
  zona.ondrop = (e) => { e.preventDefault(); zona.classList.remove('sobre'); inp.files = e.dataTransfer.files; inp.onchange(); };
  b.onclick = async () => {
    const f = inp.files[0];
    b.disabled = true; b.textContent = 'Procesando'; b.classList.add('cargando');
    error($('#p-error'));
    try {
      const r = await motor(f, f.name);
      abrirLote(r.lote_id);
    } catch (e) {
      error($('#p-error'), e.message);
      b.disabled = false; b.textContent = 'Procesar'; b.classList.remove('cargando');
    }
  };
}

// ---------------------------------------------------------------- procesos (lotes)
async function tabLotes() {
  $('#contenido').innerHTML = '<p class="aviso cargando">Cargando</p>';
  const { data, error: e } = await sb.from('lotes').select('id, archivo, estado, n_os, total_neto_erp, total_neto_pref, creado_en')
    .eq('rut', est.cliente.rut).order('creado_en', { ascending: false });
  if (e) return error($('#contenido'), e.message);
  $('#contenido').innerHTML = data.length ? tabla(['Fecha', 'Archivo', 'Estado', 'OS', 'Neto ERP', 'Neto prefactura', 'Diferencia'],
    data.map((l) => `<tr class="clic" data-lote="${l.id}"><td>${fecha(l.creado_en)}</td><td>${esc(l.archivo)}</td>
      <td><span class="chip ${l.estado}">${l.estado}</span></td><td class="n">${num(l.n_os)}</td>
      <td class="n">${pesos(l.total_neto_erp)}</td><td class="n">${pesos(l.total_neto_pref)}</td>
      <td class="n ${signo(l.total_neto_pref - l.total_neto_erp)}">${pesos(l.total_neto_pref - l.total_neto_erp)}</td></tr>`))
    : '<div class="vacio">Aún no hay procesos para este cliente.</div>';
  $('#contenido').onclick = (ev) => { const tr = ev.target.closest('[data-lote]'); if (tr) abrirLote(tr.dataset.lote); };
}

async function abrirLote(id, sub = 'ajustes') {
  $('#panel').innerHTML = '<p class="aviso cargando">Cargando proceso</p>';
  try {
    const { data: l, error: e } = await sb.from('lotes').select('*').eq('id', id).single();
    if (e) throw e;
    const [aj, ob, pend] = await Promise.all([
      todo((a, b) => sb.from('lote_ajustes').select('*').eq('lote_id', id).order('id').range(a, b)),
      todo((a, b) => sb.from('lote_observaciones').select('*').eq('lote_id', id).order('id').range(a, b)),
      sb.from('lote_os').select('os', { count: 'exact', head: true }).eq('lote_id', id).eq('estado', 'PENDIENTE'),
    ]);
    est.cliente = est.clientes.find((c) => c.rut === l.rut) ?? est.cliente;
    est.lote = { l, aj, ob, pendientes: pend.count ?? 0 };
    pintarCartera();
    pintarLote(sub);
  } catch (e) {
    $('#panel').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function pintarLote(sub) {
  const { l, aj, ob, pendientes } = est.lote;
  const todas = l.propuestas?.resumen?.find((p) => p.Regla === 'TODAS');
  const dif = l.total_neto_pref - l.total_neto_erp;
  const kpi = (t, v, cls = '') => `<div class="kpi ${cls}"><span>${t}</span><b>${v}</b></div>`;
  $('#panel').innerHTML = `<div class="cab">
      <div><button class="peq" id="b-volver">← Procesos</button>
        <h2 style="margin-top:8px">${esc(est.cliente.razon_social)} · ${esc(l.archivo)}</h2>
        <div class="aviso">Procesado ${fecha(l.creado_en)} · <span class="chip ${l.estado}">${l.estado}</span>
        ${l.cerrado_en ? ` · cerrado ${fecha(l.cerrado_en)}` : ''}</div></div>
      <div class="acciones">
        <button class="nar" id="b-pref">Prefactura (Excel)</button>
        <button class="prim" id="b-inf">Informe de correcciones</button>
        ${l.estado === 'PROCESADO' ? '<button id="b-cerrar">Cerrar proceso</button>' : ''}
        ${esSup() && l.estado !== 'ANULADO' ? '<button id="b-anular">Anular</button>' : ''}
      </div></div>
    <div class="kpis">
      ${kpi('OS en archivo', num(l.n_os))}
      ${kpi('OS con ajuste', num(new Set(aj.map((a) => a.os)).size))}
      ${kpi('OS observadas', num(new Set(ob.map((o) => o.os)).size))}
      ${kpi('OS pendientes (sin tarifa)', num(pendientes))}
      ${kpi('Neto ERP', pesos(l.total_neto_erp))}
      ${kpi('Neto prefactura', pesos(l.total_neto_pref), 'dest')}
      ${kpi('Diferencia vs ERP', `<span class="${signo(dif)}">${pesos(dif)}</span>`)}
      ${todas ? kpi('Si se aprueban las propuestas', pesos(todas.Neto_con_regla)) : ''}
    </div>
    <div class="tabs">${[['ajustes', `Ajustes (${aj.length})`], ['observadas', `Observadas (${ob.length})`], ['propuestas', 'Impacto de propuestas']]
      .map(([k, t]) => `<button data-sub="${k}" class="${sub === k ? 'activo' : ''}">${t}</button>`).join('')}</div>
    <div id="sub"></div>`;
  $('#b-volver').onclick = () => abrirCliente(l.rut, 'lotes');
  $('#b-pref').onclick = () => conEspera($('#b-pref'), () => excelPrefactura(l));
  $('#b-inf').onclick = () => conEspera($('#b-inf'), () => excelInforme(est.lote));
  $('#panel .tabs').onclick = (e) => { const b = e.target.closest('[data-sub]'); if (b) pintarLote(b.dataset.sub); };
  if ($('#b-cerrar')) $('#b-cerrar').onclick = () => cambiarLote(l, 'CERRADO', '¿Cerrar este proceso? La prefactura queda definitiva y ya no se pueden editar las observaciones.');
  if ($('#b-anular')) $('#b-anular').onclick = () => cambiarLote(l, 'ANULADO', '¿Anular este proceso? Quedará registrado como anulado y no se podrá reabrir.');

  const corto = (n) => (n > MAX_FILAS ? `<p class="aviso">Se muestran ${MAX_FILAS} de ${num(n)} filas. El informe Excel trae todas.</p>` : '');
  if (sub === 'ajustes') {
    $('#sub').innerHTML = aj.length ? corto(aj.length) + tabla(['OS', 'Campo', 'Valor ERP', 'Valor corregido', 'Diferencia', 'Regla'],
      aj.slice(0, MAX_FILAS).map((a) => `<tr><td class="mono">${esc(a.os)}</td><td>${esc(a.campo)}</td><td class="n">${num(a.valor_erp)}</td>
        <td class="n">${num(a.valor_corregido)}</td><td class="n ${signo(a.valor_corregido - a.valor_erp)}">${num(a.valor_corregido - a.valor_erp)}</td>
        <td class="regla" title="${esc(explicar(a.regla))}">${esc(a.regla)}</td></tr>`)) : '<div class="vacio">Sin ajustes: el archivo coincide con las tarifas.</div>';
  } else if (sub === 'observadas') {
    const editable = l.estado === 'PROCESADO';
    $('#sub').innerHTML = ob.length ? `<p class="aviso">Casos que el sistema no corrige y requieren revisión manual.${editable ? ' Anota cómo se resolvió cada uno; se guarda al salir del campo.' : ''}</p>`
      + corto(ob.length) + tabla(['OS', 'Regla', 'Detalle', 'Resolución'],
      ob.slice(0, MAX_FILAS).map((o) => `<tr><td class="mono">${esc(o.os)}</td><td class="regla" title="${esc(explicar(o.regla))}">${esc(o.regla)}</td><td>${esc(o.detalle)}</td>
        <td>${editable ? `<input data-obs="${o.id}" value="${esc(o.resolucion)}" placeholder="Pendiente">` : esc(o.resolucion ?? '—')}</td></tr>`))
      : '<div class="vacio">Sin observaciones.</div>';
    $('#sub').onchange = async (e) => {
      const inp = e.target.closest('[data-obs]');
      if (!inp) return;
      const { error: er } = await sb.from('lote_observaciones').update({ resolucion: inp.value.trim() || null }).eq('id', inp.dataset.obs);
      inp.style.borderColor = er ? 'var(--mal)' : 'var(--ok)';
      if (!er) ob.find((o) => String(o.id) === inp.dataset.obs).resolucion = inp.value.trim() || null;
    };
  } else {
    const p = l.propuestas?.resumen ?? [];
    $('#sub').innerHTML = p.length ? `<p class="aviso">Cuánto cambiaría el neto de este archivo si se aprobara cada regla en propuesta.</p>` + tablaPropuestas(p)
      : '<div class="vacio">El cliente no tenía reglas en propuesta al procesar este archivo.</div>';
  }
}

const tablaPropuestas = (p) => tabla(['Regla', 'Descripción', 'OS afectadas', 'Neto actual', 'Neto con regla', 'Diferencia'],
  p.map((x) => `<tr><td><b>${esc(x.Regla)}</b></td><td>${esc(x.Descripcion)}</td><td class="n">${num(x.OS_afectadas)}</td>
    <td class="n">${pesos(x.Neto_prefactura)}</td><td class="n">${pesos(x.Neto_con_regla)}</td>
    <td class="n ${signo(x.Diferencia)}">${pesos(x.Diferencia)}</td></tr>`));

async function cambiarLote(l, nuevo, pregunta) {
  if (!confirm(pregunta)) return;
  const { error: e } = await sb.from('lotes').update({ estado: nuevo }).eq('id', l.id);
  if (e) return modal(`<div class="error">${esc(e.message)}</div>`);
  abrirLote(l.id);
}

async function conEspera(boton, fn) {
  const t = boton.textContent;
  boton.disabled = true; boton.classList.add('cargando');
  try { await fn(); } catch (e) { modal(`<div class="error">${esc(e.message)}</div>`); }
  boton.disabled = false; boton.classList.remove('cargando'); boton.textContent = t;
}

// ---------------------------------------------------------------- Excel
function hoja(wb, nombre, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = (aoa[0] ?? []).map((_, j) => ({ wch: Math.min(45, Math.max(8, ...aoa.slice(0, 300).map((r) => String(r[j] ?? '').length)) + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, nombre);
}
const filasLote = (id) => todo((a, b) => sb.from('lote_os').select('os, estado, fila_pref').eq('lote_id', id).order('n').range(a, b));
const nombreArchivo = (pref) => `${pref}_${est.cliente.razon_social.replace(/[^\w]+/g, '_')}_${est.cliente.rut}_${hoy()}.xlsx`;

async function excelPrefactura(l) {
  const cols = l.columnas;
  const filas = (await filasLote(l.id)).filter((f) => f.estado === 'PREFACTURA');
  const suma = (c) => filas.reduce((a, f) => a + (Number(f.fila_pref[c]) || 0), 0);
  const aoa = [cols, ...filas.map((f) => cols.map((c) => f.fila_pref[c] ?? null)),
    cols.map((c, j) => (j === 0 ? 'TOTAL' : ['Total Neto', 'Iva', 'Total'].includes(c) ? suma(c) : null))];
  const wb = XLSX.utils.book_new();
  hoja(wb, 'Prefactura', aoa);
  XLSX.writeFile(wb, nombreArchivo('Prefactura'));
}

async function excelInforme({ l, aj, ob, pendientes }) {
  const filas = await filasLote(l.id);
  const conAj = new Set(aj.map((a) => a.os)), conOb = new Set(ob.map((o) => o.os));
  const todas = l.propuestas?.resumen?.find((p) => p.Regla === 'TODAS');
  const vig = l.reglas_usadas?.vigentes ?? [], prop = l.reglas_usadas?.propuestas ?? [];
  const wb = XLSX.utils.book_new();
  hoja(wb, 'Resumen', [['Indicador', 'Valor'],
    ['Cliente', `${est.cliente.rut} ${est.cliente.razon_social}`], ['Archivo', l.archivo], ['Procesado', fecha(l.creado_en)],
    ['Estado del proceso', l.estado], ['OS en archivo', l.n_os],
    ['OS cobrables', filas.filter((f) => !String(f.fila_pref.Servicio ?? '').startsWith('LIBRE')).length],
    ['OS con ajuste', conAj.size], ['OS observadas (revisión manual)', conOb.size],
    ['OS pendientes (sin tarifa, fuera de la prefactura)', pendientes],
    ['Reglas vigentes aplicadas', vig.length], ['Reglas en propuesta (no aplicadas)', prop.length],
    ['Total neto ERP', l.total_neto_erp], ['Total neto prefactura', l.total_neto_pref],
    ['Diferencia neto vs ERP', l.total_neto_pref - l.total_neto_erp],
    ['Total neto si se aprueban todas las propuestas', todas ? todas.Neto_con_regla : l.total_neto_pref],
    ['Versión tablas ERP (carga)', JSON.stringify(l.erp_cargas_usadas)], ['Huella del archivo (SHA-256)', l.sha256]]);
  hoja(wb, 'Prefactura', [['Estado', 'Revisión', ...l.columnas], ...filas.map((f) => [f.estado,
    [conAj.has(f.os) && 'Ajustada', conOb.has(f.os) && 'Observada'].filter(Boolean).join(' y '),
    ...l.columnas.map((c) => f.fila_pref[c] ?? null)])]);
  hoja(wb, 'Ajustes', [['OS', 'Campo', 'Valor ERP', 'Valor corregido', 'Diferencia', 'Regla'],
    ...aj.map((a) => [a.os, a.campo, a.valor_erp, a.valor_corregido, a.valor_corregido - a.valor_erp, a.regla])]);
  hoja(wb, 'Observadas', [['OS', 'Regla', 'Detalle', 'Resolución', 'Resuelto'],
    ...ob.map((o) => [o.os, o.regla, o.detalle, o.resolucion, fecha(o.resuelto_en)])]);
  const porRegla = {};
  for (const o of ob) (porRegla[o.regla] ??= new Set()).add(o.os);
  hoja(wb, 'Observadas resumen', [['Regla', 'OS'], ...Object.entries(porRegla).map(([r, s]) => [r, s.size])]);
  const pr = l.propuestas?.resumen ?? [], pd = l.propuestas?.detalle ?? [];
  hoja(wb, 'Propuestas', [['Regla', 'Descripción', 'OS afectadas', 'Neto prefactura', 'Neto con regla', 'Diferencia'],
    ...pr.map((p) => [p.Regla, p.Descripcion, p.OS_afectadas, p.Neto_prefactura, p.Neto_con_regla, p.Diferencia])]);
  if (pd.length) { const c = Object.keys(pd[0]); hoja(wb, 'Propuestas detalle', [c, ...pd.map((d) => c.map((k) => d[k] ?? null))]); }
  const cr = ['codigo', 'tipo', 'estado', 'servicio', 'via', 'desde', 'hasta', 'palabra', 'excluir', 'largo', 'ancho', 'alto',
    'modo', 'condicion', 'valor', 'valor_txt', 'min_neto', 'max_neto', 'nota', 'aprobado_en'];
  hoja(wb, 'Reglas del cliente', [cr.map((c) => c.toUpperCase()), ...[...vig, ...prop].map((g) => cr.map((c) => g[c] ?? null))]);
  hoja(wb, 'Maestro de reglas', [['Id', 'Regla', 'Qué revisa', 'Qué hace el sistema', 'Estado'],
    ...est.rs.map((r) => [r.id, r.nombre, r.logica, r.accion, r.estado])]);
  XLSX.writeFile(wb, nombreArchivo('Informe_correcciones'));
}

// ---------------------------------------------------------------- reglas
const TIPOS = {
  MEDIDAS: { c: ['servicio', 'via', 'palabra', 'excluir', 'largo', 'ancho', 'alto', 'modo', 'condicion'], req: ['palabra', 'largo', 'ancho', 'alto'],
    modos: [['POR_PIEZA', 'Por pieza'], ['POR_ENVIO', 'Por envío']],
    ayuda: 'Reemplaza largo, ancho y alto, y recalcula el KG.V, cuando la descripción contiene alguna de las palabras (se comparan sin espacios; | separa opciones).' },
  PESO: { c: ['servicio', 'via', 'valor_txt'], req: ['valor_txt'], valor_txt: 'Peso a cobrar (FISICO, VOLUMETRICO o AMBOS)', lista: 'r-pesos',
    ayuda: 'Define con qué peso se cobra. AMBOS = el mayor entre físico y volumétrico. Sin regla se usa el criterio del contrato.' },
  SERVICIO: { c: ['servicio', 'via', 'valor_txt'], req: ['servicio', 'valor_txt'], servicio: 'Servicio que se cobra distinto', valor_txt: 'Cobrar con la tarifa de',
    ayuda: 'Cobra un servicio con la tarifa de otro. Ej.: COOLER con la tarifa de CARGA.' },
  DESCUENTO: { c: ['servicio', 'via', 'valor', 'min_neto', 'max_neto'], req: ['valor'], valor: 'Descuento %',
    ayuda: '% de descuento sobre el transporte. Con tramo, aplica solo si el transporte total del archivo está dentro del rango.' },
  RECARGO: { c: ['servicio', 'via', 'valor', 'palabra'], req: ['valor'], valor: 'Recargo %', palabra: 'Comunas (vacío = todas las secundarias)',
    ayuda: 'Reemplaza el % de recargo de comuna del contrato. 60 = transporte × 1,6.' },
  CARGO_FIJO: { c: ['servicio', 'via', 'valor', 'modo'], req: ['valor'], valor: 'Monto $', modos: [['POR_OS', 'Por OS'], ['POR_PIEZA', 'Por pieza']],
    ayuda: 'Suma un monto fijo a Valor Extra, por OS o por pieza. Usa Servicio para limitarlo (ej. REFRIGERADO).' },
  COMBUSTIBLE: { c: ['servicio', 'via', 'valor'], req: ['valor'], valor: 'Recargo combustible %',
    ayuda: '% sobre el transporte que se suma a Valor Extra.' },
  EXIMIR: { c: ['servicio', 'via', 'palabra'], req: ['palabra'], palabra: 'Palabras en descripción o servicio (| separa)',
    ayuda: 'Deja el transporte en $0 cuando la descripción o el servicio contiene alguna de las palabras.' },
};
const ETIQUETAS = { servicio: 'Servicio (filtro, vacío = todos)', palabra: 'Palabras en descripción (| separa)', valor: 'Valor', valor_txt: 'Valor' };
const TEXTO = ['servicio', 'via', 'palabra', 'excluir', 'modo', 'condicion', 'valor_txt'];
const NUMERO = ['largo', 'ancho', 'alto', 'valor', 'min_neto', 'max_neto'];

function parametros(g) {
  const m = (x) => num(x);
  switch (g.tipo) {
    case 'MEDIDAS': return `${g.palabra} → ${m(g.largo)}×${m(g.ancho)}×${m(g.alto)} cm ${g.modo === 'POR_ENVIO' ? 'por envío' : 'por pieza'}`
      + `${g.excluir ? ` · excepto ${g.excluir}` : ''}${g.condicion === 'SOLO_SI_BAJA' ? ' · solo si baja' : ''}`;
    case 'PESO': return `Cobrar peso ${g.valor_txt}`;
    case 'SERVICIO': return `${g.servicio} con tarifa de ${g.valor_txt}`;
    case 'DESCUENTO': return `${m(g.valor)}%${g.min_neto != null ? ` si transporte entre ${pesos(g.min_neto)} y ${pesos(g.max_neto)}` : ''}`;
    case 'RECARGO': return `${m(g.valor)}%${g.palabra ? ` en ${g.palabra}` : ''}`;
    case 'CARGO_FIJO': return `${pesos(g.valor)} ${g.modo === 'POR_PIEZA' ? 'por pieza' : 'por OS'}`;
    case 'COMBUSTIBLE': return `${m(g.valor)}% del transporte`;
    case 'EXIMIR': return `Transporte $0 si contiene ${g.palabra}`;
    default: return '';
  }
}

async function tabReglas() {
  $('#contenido').innerHTML = '<p class="aviso cargando">Cargando</p>';
  const { data: rg, error: e } = await sb.from('reglas').select('*').eq('rut', est.cliente.rut).order('id');
  if (e) return error($('#contenido'), e.message);
  est.reglas = rg;
  const filtro = (g) => [g.servicio, g.via, g.desde && `desde ${g.desde}`, g.hasta && `hasta ${g.hasta}`].filter(Boolean).join(' · ') || 'Todas las OS';
  $('#contenido').innerHTML = `<div class="cab"><p class="aviso" style="margin:0">Las reglas nacen como <b>propuesta</b>: no cambian la prefactura hasta que se aprueban con su respaldo.
      Una regla vigente no se edita: se inactiva y se crea otra.</p>
      <div class="acciones"><button id="b-simular">Simular propuestas con el último archivo</button><button class="prim" id="b-nueva">Nueva regla</button></div></div>
    <div id="sim"></div>
    ${rg.length ? tabla(['Código', 'Tipo', 'Estado', 'Aplica a', 'Regla', 'Acuerdo', 'Acciones'], rg.map((g) => `<tr>
      <td class="mono">${esc(g.codigo)}</td><td>${esc(g.tipo)}</td><td><span class="chip ${g.estado}">${g.estado}</span></td>
      <td>${esc(filtro(g))}</td><td>${esc(parametros(g))}</td>
      <td>${esc(g.nota)}${g.respaldo_path ? `<br><button class="enlace" data-respaldo="${esc(g.respaldo_path)}">Ver respaldo</button>` : ''}</td>
      <td style="white-space:nowrap">${g.estado === 'PROPUESTA' ? `<button class="peq prim" data-ac="aprobar" data-id="${g.id}">Aprobar</button>
        <button class="peq" data-ac="rechazar" data-id="${g.id}">Rechazar</button>` : ''}
        ${g.estado === 'VIGENTE' ? `<button class="peq" data-ac="inactivar" data-id="${g.id}">Inactivar</button>` : ''}
        <button class="peq" data-ac="historial" data-id="${g.id}">Historial</button></td></tr>`))
    : '<div class="vacio">Este cliente aún no tiene reglas.</div>'}`;
  $('#b-nueva').onclick = abrirModalRegla;
  $('#b-simular').onclick = () => conEspera($('#b-simular'), simular);
  $('#contenido').onclick = async (ev) => {
    const r = ev.target.closest('[data-respaldo]');
    if (r) {
      const { data, error: er } = await sb.storage.from('respaldos').createSignedUrl(r.dataset.respaldo, 120);
      return er ? modal(`<div class="error">${esc(er.message)}</div>`) : window.open(data.signedUrl, '_blank', 'noopener');
    }
    const b = ev.target.closest('[data-ac]');
    if (b) accionRegla(b.dataset.ac, est.reglas.find((g) => String(g.id) === b.dataset.id));
  };
}

async function simular() {
  const { data: ult } = await sb.from('lotes').select('archivo, archivo_path, creado_en').eq('rut', est.cliente.rut)
    .neq('estado', 'ANULADO').order('creado_en', { ascending: false }).limit(1).maybeSingle();
  if (!ult) return void ($('#sim').innerHTML = '<div class="error">Procesa al menos un archivo de este cliente para poder simular.</div>');
  const { data: blob, error: e } = await sb.storage.from('cargas').download(ult.archivo_path);
  if (e) throw e;
  const r = await motor(blob, ult.archivo, true);
  $('#sim').innerHTML = `<h3 style="margin:14px 0 6px">Simulación sobre ${esc(ult.archivo)} (${fecha(ult.creado_en)})</h3>`
    + (r.propuestas.length ? tablaPropuestas(r.propuestas) : '<div class="vacio">No hay reglas en propuesta para simular.</div>');
}

function sufijoCodigo() {
  const pref = est.cliente.razon_social.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'REG';
  const max = Math.max(0, ...est.reglas.map((g) => (g.codigo.startsWith(`${pref}-`) ? Number(g.codigo.slice(pref.length + 1)) || 0 : 0)));
  return `${pref}-${String(max + 1).padStart(2, '0')}`;
}

function ajustarModal() {
  const t = TIPOS[$('#r-tipo').value];
  document.querySelectorAll('#f-regla [data-c]').forEach((d) => d.classList.toggle('oculto', !t.c.includes(d.dataset.c)));
  for (const c of [...TEXTO, ...NUMERO]) {
    const inp = $(`#r-${c}`);
    if (inp) inp.required = t.req.includes(c);
    const lab = $(`#r-${c}-l`);
    if (lab) lab.textContent = t[c] ?? ETIQUETAS[c];
  }
  $('#r-valor_txt').setAttribute('list', t.lista ?? '');
  $('#r-modo').innerHTML = (t.modos ?? []).map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
  $('#r-ayuda').textContent = t.ayuda;
}
$('#r-tipo').onchange = ajustarModal;
$('#r-cancelar').onclick = () => $('#d-regla').close();

function abrirModalRegla() {
  $('#f-regla').reset();
  error($('#r-error'));
  $('#r-cliente').textContent = `${est.cliente.razon_social} · se creará como ${sufijoCodigo()} en estado PROPUESTA`;
  ajustarModal();
  $('#d-regla').showModal();
}

const nombreSeguro = (n) => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]/g, '_').slice(-80);
async function subirRespaldo(codigo, archivo) {
  const ruta = `${est.cliente.rut}/${codigo}/${Date.now()}_${nombreSeguro(archivo.name)}`;
  const { error: e } = await sb.storage.from('respaldos').upload(ruta, archivo);
  if (e) throw new Error(`No se pudo subir el respaldo: ${e.message}`);
  return ruta;
}

$('#f-regla').onsubmit = async (e) => {
  e.preventDefault();
  const tipo = $('#r-tipo').value, t = TIPOS[tipo], v = (c) => $(`#r-${c}`).value.trim();
  const codigo = sufijoCodigo();
  const fila = { rut: est.cliente.rut, codigo, tipo, desde: v('desde') || null, hasta: v('hasta') || null, nota: v('nota') };
  for (const c of TEXTO) fila[c] = t.c.includes(c) && v(c) ? v(c).toUpperCase() : null;
  for (const c of NUMERO) fila[c] = t.c.includes(c) && v(c) !== '' ? Number(v(c)) : null;
  if (tipo === 'PESO' && !['FISICO', 'VOLUMETRICO', 'AMBOS'].includes(fila.valor_txt)) return error($('#r-error'), 'El peso debe ser FISICO, VOLUMETRICO o AMBOS.');
  if (fila.min_neto != null && fila.max_neto == null) return error($('#r-error'), 'Si indicas “transporte total desde”, indica también “hasta”.');
  const boton = $('#f-regla button[type=submit]');
  boton.disabled = true;
  try {
    if ($('#r-respaldo').files[0]) fila.respaldo_path = await subirRespaldo(codigo, $('#r-respaldo').files[0]);
    const { error: er } = await sb.from('reglas').insert(fila);
    if (er) throw er;
    $('#d-regla').close();
    tabReglas();
  } catch (er) {
    error($('#r-error'), er.message);
  }
  boton.disabled = false;
};

async function accionRegla(accion, g) {
  if (accion === 'historial') return historial(g);
  const preguntas = {
    aprobar: `¿Aprobar ${g.codigo}? Desde ahora se aplicará en las prefacturas de ${est.cliente.razon_social}.`,
    rechazar: `¿Rechazar la propuesta ${g.codigo}? No se podrá reactivar.`,
    inactivar: `¿Inactivar ${g.codigo}? Deja de aplicarse en los próximos procesos.`,
  };
  if (!confirm(preguntas[accion])) return;
  const cambio = { estado: { aprobar: 'VIGENTE', rechazar: 'RECHAZADA', inactivar: 'INACTIVA' }[accion] };
  if (accion === 'aprobar' && !g.respaldo_path) {
    const archivo = await elegirArchivo();
    if (!archivo) return;
    try { cambio.respaldo_path = await subirRespaldo(g.codigo, archivo); } catch (e) { return modal(`<div class="error">${esc(e.message)}</div>`); }
  }
  const { error: e } = await sb.from('reglas').update(cambio).eq('id', g.id);
  if (e) return modal(`<div class="error">${esc(e.message)}</div>`);
  tabReglas();
}

function elegirArchivo() {
  return new Promise((ok) => {
    modal('<h2>Respaldo requerido</h2><p>Para aprobar la regla adjunta el acuerdo que la respalda (correo, contrato o tarifa firmada).</p><button class="prim" id="b-elegir">Elegir archivo</button>');
    const inp = $('#f-respaldo-aprobar');
    inp.value = '';
    $('#b-elegir').onclick = () => inp.click();
    inp.onchange = () => { $('#d-info').close(); ok(inp.files[0] ?? null); };
    $('#d-info').addEventListener('close', () => ok(null), { once: true });
  });
}

async function historial(g) {
  const [{ data: h }, { data: per }] = await Promise.all([
    sb.from('reglas_historial').select('*').eq('regla_id', g.id).order('fecha'),
    sb.from('perfiles').select('user_id, nombre'),
  ]);
  const quien = (id) => (per ?? []).find((p) => p.user_id === id)?.nombre ?? (id ? `usuario ${id.slice(0, 8)}` : 'sistema');
  modal(`<h2>Historial de ${esc(g.codigo)}</h2><p class="aviso">${esc(parametros(g))}</p>` + tabla(['Fecha', 'Usuario', 'Acción', 'Estado'],
    (h ?? []).map((x) => `<tr><td>${fecha(x.fecha)}</td><td>${esc(quien(x.usuario))}</td>
      <td>${x.accion === 'INSERT' ? 'Creada' : 'Modificada'}</td>
      <td>${x.antes ? `${esc(x.antes.estado)} → ` : ''}<span class="chip ${esc(x.despues.estado)}">${esc(x.despues.estado)}</span></td></tr>`)));
}

iniciar();
