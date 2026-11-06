// Carga de tablas ERP (export manual). Autenticación propia: header x-carga-token = secreto CARGA_ERP_TOKEN.
// ponytail: token compartido; reemplazar por JWT de usuario admin cuando exista la pantalla de carga.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TABLA: Record<string, string> = {
  SUCURSALES: "erp_sucursales",
  CONTRATOS: "erp_contratos",
  TARIFAS: "erp_tarifas",
  SERVICIOS: "erp_servicios",
  SORTER: "erp_sorter",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Usar POST", { status: 405 });
  const token = Deno.env.get("CARGA_ERP_TOKEN");
  if (!token || req.headers.get("x-carga-token") !== token) {
    return new Response("No autorizado", { status: 401 });
  }
  const { tipo, archivo, sha256, filas } = await req.json();
  const tabla = TABLA[tipo];
  if (!tabla || !archivo || !sha256 || !Array.isArray(filas) || filas.length === 0) {
    return new Response("Payload inválido", { status: 400 });
  }
  const { data: carga, error } = await db.from("erp_cargas")
    .insert({ tipo, archivo, sha256, filas: filas.length }).select("id").single();
  if (error) return Response.json(error, { status: 500 });

  for (let i = 0; i < filas.length; i += 1000) {
    const lote = filas.slice(i, i + 1000).map((f: Record<string, unknown>) => ({ ...f, carga_id: carga.id }));
    const { error } = await db.from(tabla).insert(lote);
    if (error) {
      await db.from("erp_cargas").delete().eq("id", carga.id); // todo o nada
      return Response.json({ tipo, fila_desde: i, error }, { status: 500 });
    }
  }
  return Response.json({ tipo, carga_id: carga.id, filas: filas.length });
});
