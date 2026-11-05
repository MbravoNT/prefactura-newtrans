# Prefactura · Newtrans

Plataforma del área comercial para revisar el archivo **"O/S sin facturar"** del ERP, corregirlo con las tarifas del
convenio y las reglas acordadas con cada cliente, y entregar la **prefactura** con un **informe de todo lo corregido**.

Publicada en GitHub Pages: https://mbravont.github.io/prefactura-newtrans/

## Piezas

| Pieza | Dónde |
|---|---|
| Pantalla (SPA) | `index.html`, `app.js` |
| Motor de prefactura (port fiel de `motor.py` v0.3) | `supabase/functions/procesar-prefactura/motor.ts` |
| Función que procesa el CSV, valida cartera y guarda el lote | `supabase/functions/procesar-prefactura/index.ts` |
| Función de carga de tablas ERP (token) | `supabase/functions/cargar-erp/index.ts` |
| Prueba de regresión TS vs Python | `regresion.ts` |
| Base de datos | Supabase, proyecto `newtrans - prefactura` (sa-east-1) |

## Seguridad

- Cada ejecutivo ve solo los clientes donde figura en el maestro (`clientes.ejecutivo_erp` = `perfiles.nombre_erp`); RLS lo impone.
- Jefatura y administrador ven todo. Solo correos en `usuarios_autorizados` reciben perfil al registrarse.
- Las reglas nacen como PROPUESTA; pasan a VIGENTE solo con respaldo adjunto. Una regla vigente no se edita. Todo cambio queda en `reglas_historial`.
- Un proceso CERRADO no se modifica; solo jefatura puede anularlo.
- La clave en `app.js` es la clave publicable de Supabase (pública por diseño). La clave de servicio vive solo en las funciones.

## Regresión del motor

```
node --experimental-strip-types regresion.ts "<carpeta P factura>"
```
Compara cada OS, ajuste, observación y propuesta de Tecnika y Clinical Market contra la salida de `motor.py`
(`motor/regresion/ref_*.json`, generada con `motor/regresion/referencia.py`).

## Actualizar tablas del ERP

Desde `D:\IA\P factura`: `python carga_erp\preparar.py` y luego `node carga_erp\cargar_erp.mjs` (pide el token).
Cada carga queda versionada en `erp_cargas`; los procesos usan siempre la última.
