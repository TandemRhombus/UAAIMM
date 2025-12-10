// index.js
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const https = require('https'); // <--- NUEVO
const fs = require('fs');
const net = require('net');

// [NUEVO] Librería de Google Auth
const { OAuth2Client } = require('google-auth-library');

const {
  TWITTER_API_KEY,
  TWITTER_API_KEY_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET,
  UAA_NOMBRE,
  TWEET_ENABLE,
  GOOGLE_CLIENT_ID // [NUEVO] Variable del .env
} = process.env;

const {
  saveEncrypted,
  readEncrypted,
  listAllEncrypted,
  DFS_BASE_PATH
} = require('./dfsService');

const app = express();
const PORT = process.env.PORT || 3000;

// [NUEVO] Cliente para verificar tokens de Google
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// =================== CONFIG / MIDDLEWARE ===================
app.use(express.json());

// Servir archivos estáticos (Frontend Web)
app.use(express.static('public'));

function isUaaEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return email.toLowerCase().endsWith('@edu.uaa.mx');
}

// Estados válidos según el ER
const ESTADOS_VALIDOS = ['ABIERTO', 'EN_ATENCION', 'RESUELTO', 'CERRADO', 'REABIERTO'];

// =================== HELPERS DE FECHAS (CORREGIDOS) ===================

function obtenerPeriodo(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`; // Ejemplo: "2025-11"
}

// Devuelve el periodo actual (para pruebas manuales hoy)
function periodoActual() {
  return obtenerPeriodo(new Date());
}

// Devuelve el periodo del mes PASADO (para el reporte automático del día 1)
function periodoAnterior() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1); // Restar un mes
  return obtenerPeriodo(d);
}

/**
 * Lee todas las categorías y reportes cifrados y genera métricas
 */
function calcularMetricasPorPeriodo(periodo) {
  console.log(`[Metrics] Calculando para periodo: ${periodo}`);
  
  // 1. Cargar Categorías
  const categorias = listAllEncrypted('categorias');
  const categoriasPorId = {};
  categorias.forEach(c => { if (c && c.id) categoriasPorId[c.id] = c; });

  // 2. Cargar Reportes
  const reportes = listAllEncrypted('reportes');
  const metricas = {}; // catId -> {reportados, resueltos}
  
  let totalProcesados = 0;

  for (const r of reportes) {
    if (!r) continue;

    // Validar fecha de creación
    const fechaCreacion = r.createdAt || r.created_at;
    if (!fechaCreacion) continue;

    const per = obtenerPeriodo(fechaCreacion);
    
    // FILTRO DE FECHA: Solo contamos lo de este mes específico
    if (per !== periodo) {
      continue; 
    }

    totalProcesados++;

    const catId = r.categoriaId || r.categoria_id;
    if (!catId) continue; 

    // Inicializar contador si es la primera vez
    if (!metricas[catId]) {
      metricas[catId] = { reportados: 0, resueltos: 0 };
    }

    // SIEMPRE SUMA AL TOTAL (Abiertos + Cerrados)
    metricas[catId].reportados += 1;

    // Solo suma a resueltos si cumple la condición
    const estado = r.estadoActual || r.estado_actual;
    if (estado === 'RESUELTO' || estado === 'CERRADO') {
      metricas[catId].resueltos += 1;
    }
  }

  console.log(`[Metrics] Total reportes encontrados en ${periodo}: ${totalProcesados}`);
  return { periodo, metricas, categoriasPorId };
}

// =================== Cliente de X (Twitter) ===================

function getTwitterClient() {
  if (!TWITTER_API_KEY || !TWITTER_API_KEY_SECRET || !TWITTER_ACCESS_TOKEN) return null;
  return new TwitterApi({
    appKey: TWITTER_API_KEY,
    appSecret: TWITTER_API_KEY_SECRET,
    accessToken: TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_TOKEN_SECRET
  });
}

// Función maestra de publicación
async function ejecutarPublicacion(periodoObjetivo) {
  const { metricas, categoriasPorId } = calcularMetricasPorPeriodo(periodoObjetivo);
  const texto = construirTextoPublicacion(periodoObjetivo, metricas, categoriasPorId);
  const client = getTwitterClient();
  
  if (!client || String(TWEET_ENABLE).toLowerCase() === 'false') {
    console.log('📝 [SIMULACIÓN TWITTER]:\n' + texto);
    return { publicado: false, texto, modo: 'SIMULACION' };
  }

  try {
    const res = await client.v2.tweet(texto);
    console.log('🐦 Tweet publicado ID:', res.data.id);
    return { publicado: true, tweetId: res.data.id, texto };
  } catch (e) {
    console.error('❌ Error publicando en X:', e);
    return { publicado: false, error: e.message };
  }
}

// =================== GENERADOR DE TWEET "BONITO" ===================

function construirTextoPublicacion(periodo, metricas, categoriasPorId) {
  const nombreUaa = UAA_NOMBRE || 'la UAA';
  const [year, month] = periodo.split('-');
  const meses = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const nombreMes = meses[parseInt(month) - 1];

  // Encabezado
  let encabezado = `📊 Reporte Mensual ${nombreUaa}\n🗓️ ${nombreMes} ${year}\n\n`;
  let cuerpo = '';
  
  const catIds = Object.keys(metricas);

  if (catIds.length === 0) {
    return encabezado + '✅ Sin incidentes registrados este mes. #UAA';
  }

  // Ordenar por número de reportes (Mayor a menor)
  catIds.sort((a, b) => metricas[b].reportados - metricas[a].reportados);

  for (const catId of catIds) {
    const { reportados, resueltos } = metricas[catId];
    const cat = categoriasPorId[catId];
    const nombreCat = (cat && cat.nombre) ? cat.nombre : catId;

    const porcentaje = reportados > 0 ? Math.round((resueltos / reportados) * 100) : 0;
    // Barra más corta para ahorrar espacio (3 bloques en vez de 5)
    const filled = Math.round(porcentaje / 33); 
    const bar = '▓'.repeat(filled) + '░'.repeat(3 - filled);

    // Iconos
    let icono = '🔧';
    const nombreLower = nombreCat.toLowerCase();
    if(nombreLower.includes('red') || nombreLower.includes('wifi')) icono = '📶';
    else if(nombreLower.includes('agua') || nombreLower.includes('fuga')) icono = '💧';
    else if(nombreLower.includes('luz') || nombreLower.includes('electric')) icono = '⚡';
    else if(nombreLower.includes('limpieza')) icono = '🧹';

    // Construir línea compacta
    // Ej: 🧹 Limpieza: 5 (80% resuelto) ▓▓░
    let linea = `${icono} ${nombreCat}: ${reportados} (${porcentaje}% ok) ${bar}\n`;
    
    // VALIDACIÓN DE LONGITUD EN TIEMPO REAL
    // Si agregar esta línea supera 260 chars (dejando 20 para hashtags), paramos.
    if ((encabezado.length + cuerpo.length + linea.length) > 260) {
        cuerpo += '... y más categorías.\n';
        break; 
    }
    cuerpo += linea;
  }

  let textoFinal = encabezado + cuerpo + '#UAA #SistemasDistribuidos';
  
  // Seguro final
  if (textoFinal.length > 280) {
      textoFinal = textoFinal.substring(0, 277) + '...';
  }
  
  return textoFinal;
}

async function publicarResumenMesActualEnX() {
  const periodo = periodoActual();
  const { metricas, categoriasPorId } = calcularMetricasPorPeriodo(periodo);
  const texto = construirTextoPublicacion(periodo, metricas, categoriasPorId);

  const client = getTwitterClient();
  if (!client || String(TWEET_ENABLE).toLowerCase() === 'false') {
    console.log('📝 Publicación simulada (no se manda a X):\n', texto);
    return { publicado: false, texto };
  }

  try {
    const res = await client.v2.tweet(texto);
    return {
      publicado: true,
      texto,
      tweetId: res.data.id
    };
  } catch (error) {
    console.error('Error al publicar en X:', error);
    return { publicado: false, error: error.message };
  }
}

// =================== HEALTH CHECK AVANZADO ===================

// 1. Chequeo HDFS (Puerto TCP 9000)
function checkHdfsStatus() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500); // 1.5s timeout
    
    socket.on('connect', () => { 
      socket.destroy(); 
      resolve(true); 
    });
    
    socket.on('timeout', () => { 
      socket.destroy(); 
      resolve(false); 
    });
    
    socket.on('error', (err) => { 
      socket.destroy(); 
      resolve(false); 
    });
    
    // Intenta conectar al NameNode en dfs1
    socket.connect(9000, '172.16.16.101'); 
  });
}

// 2. Chequeo Drive (Archivo de Log compartido)
function checkDriveStatus() {
  try {
    const logPath = path.join(DFS_BASE_PATH, 'logs', 'drive_sync.log');
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      const now = new Date();
      // Si se modificó hace menos de 24h, está OK
      const diffHours = (now - stats.mtime) / 1000 / 60 / 60;
      return diffHours < 24 ? 'SYNCED' : 'DELAYED';
    }
    return 'NO_LOG';
  } catch (e) {
    return 'ERROR';
  }
}

// Endpoint de Salud Mejorado
app.get('/api/health', async (req, res) => {
  try {
      const hdfsUp = await checkHdfsStatus();
      const driveStatus = checkDriveStatus();
    
      res.json({
        status: 'ok',
        message: 'Backend UAA funcionando',
        dfsPath: DFS_BASE_PATH,
        hdfsStatus: hdfsUp ? 'ONLINE' : 'OFFLINE',
        driveStatus: driveStatus
      });
  } catch (err) {
      console.error("Health Check Error:", err);
      res.status(500).json({ error: "Fallo interno en health check" });
  }
});

// ======================================================
//  USUARIOS (RSA)
// ======================================================

// POST /api/usuarios
// Body: { id, nombre, correo, password }
app.post('/api/usuarios', (req, res) => {
  const usuario = req.body;

  if (!usuario || !usuario.id || !usuario.nombre || !usuario.correo || !usuario.password) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios'
    });
  }

  if (!isUaaEmail(usuario.correo)) {
    return res.status(400).json({
      error: 'Solo se permiten correos @edu.uaa.mx'
    });
  }

  try {
    try {
      readEncrypted('usuarios', usuario.id);
      return res.status(409).json({ error: 'Ya existe un usuario con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') return res.status(500).json({ error: 'Error interno' });
    }

    const payload = {
      id: usuario.id,
      nombre: usuario.nombre,
      correo: usuario.correo.toLowerCase(),
      password: usuario.password,
      // NUEVO CAMPO: Guardamos el rol directamente. Si no viene, es Alumno.
      rol: usuario.rol || 'Alumno', 
      createdAt: new Date().toISOString()
    };

    saveEncrypted('usuarios', usuario.id, payload);

    res.status(201).json({
      message: 'Usuario guardado',
      id: usuario.id
    });
  } catch (err) {
    console.error('Error al guardar usuario:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/usuarios/:id
app.get('/api/usuarios/:id', (req, res) => {
  const id = req.params.id;

  try {
    const usuario = readEncrypted('usuarios', id);
    const { password, ...usuarioSinPassword } = usuario;

    res.json({
      message: 'Usuario leído desde DFS y descifrado con RSA',
      data: usuarioSinPassword
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    console.error('Error al leer usuario (RSA):', err);
    res.status(500).json({ error: 'Error interno al leer el usuario' });
  }
});

// ======================================================
//  LOGIN (MEJORADO: ID o CORREO + GOOGLE AUTH)
// ======================================================

// LOGIN NORMAL (Soporta ID o Correo)
app.post('/api/login', (req, res) => {
  let { id, password } = req.body;

  if (!id || !password) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: id (o correo) y password'
    });
  }

  try {
    let usuario;

    // 1. Si el "id" tiene @, buscamos por correo
    if (id.includes('@')) {
      const usuarios = listAllEncrypted('usuarios');
      const encontrado = usuarios.find(u => u.correo.toLowerCase() === id.toLowerCase());
      
      if (!encontrado) {
        return res.status(401).json({ error: 'Correo no registrado' });
      }
      usuario = encontrado;
    } else {
      // 2. Si no tiene @, asumimos que es el ID (Matrícula)
      try {
        usuario = readEncrypted('usuarios', id);
      } catch (err) {
        if (err.message === 'NOT_FOUND') {
           return res.status(401).json({ error: 'Usuario no existe' });
        }
        throw err;
      }
    }

    // 3. Validar Contraseña
    if (usuario.password !== password) {
      return res.status(401).json({
        error: 'Credenciales inválidas (password incorrecto)'
      });
    }

    const { password: _, ...usuarioSinPassword } = usuario;

    res.json({
      message: 'Login exitoso',
      usuario: usuarioSinPassword
    });

  } catch (err) {
    console.error('Error en login (RSA):', err);
    res.status(500).json({ error: 'Error interno en login' });
  }
});

// [NUEVO] LOGIN CON GOOGLE (Autenticación Federada + Auto Registro)
app.post('/api/login/google', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'Falta el idToken de Google' });
  }

  try {
    // 1. Verificar el token con Google
    const ticket = await googleClient.verifyIdToken({
      idToken: idToken,
      audience: GOOGLE_CLIENT_ID, 
    });
    
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;

    // --- COMENTADO PARA PRUEBAS CON GMAIL (Descomentar en producción UAA) ---
    // if (!isUaaEmail(email)) {
    //   return res.status(403).json({ error: 'Acceso denegado: Solo cuentas @edu.uaa.mx' });
    // }

    // 2. Buscar usuario en DFS por correo
    const usuarios = listAllEncrypted('usuarios');
    let usuarioEncontrado = usuarios.find(u => u.correo.toLowerCase() === email.toLowerCase());

    // 3. LOGICA DE AUTO-REGISTRO
    // Si no existe, lo creamos ahora mismo.
    if (!usuarioEncontrado) {
      console.log(`[Google Auth] Usuario nuevo detectado: ${email}. Creando cuenta...`);
      
      // Generamos un ID único (Prefijo G + timestamp)
      const newId = 'G' + Date.now(); 
      
      const newUser = {
        id: newId,
        nombre: name || 'Usuario Google',
        correo: email.toLowerCase(),
        password: '[GOOGLE_AUTH_SECURED]',
        rol: 'Alumno', // <--- AGREGAR ESTA LÍNEA EN EL AUTO-REGISTRO DE GOOGLE
        createdAt: new Date().toISOString()
      };

      // Guardamos en DFS (cifrado)
      saveEncrypted('usuarios', newId, newUser);
      
      // Asignamos para el login
      usuarioEncontrado = newUser;
    }

    // 4. Login Exitoso
    const { password: _, ...usuarioSinPassword } = usuarioEncontrado;
    res.json({
      message: 'Login con Google exitoso',
      usuario: usuarioSinPassword,
      source: 'GOOGLE_AUTH_FEDERATED'
    });

  } catch (error) {
    console.error('Error Google Auth:', error);
    res.status(401).json({ error: 'Token de Google inválido o expirado' });
  }
});

// ======================================================
//  CATEGORÍAS
// ======================================================

// POST /api/categorias
// Body: { id, nombre, descripcion? }
app.post('/api/categorias', (req, res) => {
  const cat = req.body;

  if (!cat || !cat.id || !cat.nombre) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: id, nombre'
    });
  }

  try {
    try {
      readEncrypted('categorias', cat.id);
      return res.status(409).json({ error: 'Ya existe una categoría con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') {
        console.error('Error al verificar categoría existente:', err);
        return res.status(500).json({ error: 'Error interno' });
      }
    }

    const payload = {
      id: cat.id,
      nombre: cat.nombre,
      descripcion: cat.descripcion || '',
      createdAt: new Date().toISOString()
    };

    saveEncrypted('categorias', cat.id, payload);

    res.status(201).json({
      message: 'Categoría creada',
      id: cat.id
    });
  } catch (err) {
    console.error('Error al crear categoría:', err);
    res.status(500).json({ error: 'Error interno al crear categoría' });
  }
});

// GET /api/categorias
app.get('/api/categorias', (req, res) => {
  try {
    const categorias = listAllEncrypted('categorias');
    res.json({ data: categorias });
  } catch (err) {
    console.error('Error al listar categorías:', err);
    res.status(500).json({ error: 'Error interno al listar categorías' });
  }
});

// GET /api/categorias/:id
app.get('/api/categorias/:id', (req, res) => {
  const id = req.params.id;
  try {
    const cat = readEncrypted('categorias', id);
    res.json({ data: cat });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    console.error('Error al leer categoría:', err);
    res.status(500).json({ error: 'Error interno al leer categoría' });
  }
});

// ======================================================
//  ESTADOS (catálogo)
// ======================================================

// POST /api/estados
// Body: { id, nombre }  nombre ∈ ESTADOS_VALIDOS
app.post('/api/estados', (req, res) => {
  const e = req.body;

  if (!e || !e.id || !e.nombre) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: id, nombre'
    });
  }

  if (!ESTADOS_VALIDOS.includes(e.nombre)) {
    return res.status(400).json({
      error: `Estado no válido. Debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}`
    });
  }

  try {
    try {
      readEncrypted('estados', e.id);
      return res.status(409).json({ error: 'Ya existe un estado con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') {
        console.error('Error al verificar estado existente:', err);
        return res.status(500).json({ error: 'Error interno' });
      }
    }

    const payload = {
      id: e.id,
      nombre: e.nombre,
      createdAt: new Date().toISOString()
    };

    saveEncrypted('estados', e.id, payload);

    res.status(201).json({
      message: 'Estado creado',
      id: e.id
    });
  } catch (err) {
    console.error('Error al crear estado:', err);
    res.status(500).json({ error: 'Error interno al crear estado' });
  }
});

// GET /api/estados
app.get('/api/estados', (req, res) => {
  try {
    const estados = listAllEncrypted('estados');
    res.json({ data: estados, validos: ESTADOS_VALIDOS });
  } catch (err) {
    console.error('Error al listar estados:', err);
    res.status(500).json({ error: 'Error interno al listar estados' });
  }
});

// GET /api/estados/:id
app.get('/api/estados/:id', (req, res) => {
  const id = req.params.id;
  try {
    const estado = readEncrypted('estados', id);
    res.json({ data: estado });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Estado no encontrado' });
    }
    console.error('Error al leer estado:', err);
    res.status(500).json({ error: 'Error interno al leer estado' });
  }
});

// ======================================================
//  UBICACIONES
// ======================================================

// POST /api/ubicaciones
// Body: { id, lat, lng, area, edificio?, nivel? }
app.post('/api/ubicaciones', (req, res) => {
  const u = req.body;

  if (!u || !u.id || u.lat === undefined || u.lng === undefined || !u.area) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: id, lat, lng, area'
    });
  }

  try {
    try {
      readEncrypted('ubicaciones', u.id);
      return res.status(409).json({ error: 'Ya existe una ubicación con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') {
        console.error('Error al verificar ubicación existente:', err);
        return res.status(500).json({ error: 'Error interno' });
      }
    }

    const payload = {
      id: u.id,
      lat: u.lat,
      lng: u.lng,
      area: u.area,
      edificio: u.edificio || null,
      nivel: u.nivel || null,
      createdAt: new Date().toISOString()
    };

    saveEncrypted('ubicaciones', u.id, payload);

    res.status(201).json({
      message: 'Ubicación creada',
      id: u.id
    });
  } catch (err) {
    console.error('Error al crear ubicación:', err);
    res.status(500).json({ error: 'Error interno al crear ubicación' });
  }
});

// GET /api/ubicaciones
app.get('/api/ubicaciones', (req, res) => {
  try {
    const ubicaciones = listAllEncrypted('ubicaciones');
    res.json({ data: ubicaciones });
  } catch (err) {
    console.error('Error al listar ubicaciones:', err);
    res.status(500).json({ error: 'Error interno al listar ubicaciones' });
  }
});

// GET /api/ubicaciones/:id
app.get('/api/ubicaciones/:id', (req, res) => {
  const id = req.params.id;

  try {
    const u = readEncrypted('ubicaciones', id);
    res.json({ data: u });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Ubicación no encontrada' });
    }
    console.error('Error al leer ubicación:', err);
    res.status(500).json({ error: 'Error interno al leer ubicación' });
  }
});

// ======================================================
//  REPORTES + HISTORIAL (usa estados válidos)
// ======================================================

// POST /api/reportes
// Body: { id, titulo?, descripcion, categoriaId, ubicacionId, creadoPor }
app.post('/api/reportes', (req, res) => {
  const r = req.body;

  if (!r || !r.id || !r.descripcion || !r.categoriaId || !r.ubicacionId || !r.creadoPor) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios'
    });
  }

  const now = new Date().toISOString();

  try {
    try {
      readEncrypted('reportes', r.id);
      return res.status(409).json({ error: 'Ya existe un reporte con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') return res.status(500).json({ error: 'Error interno' });
    }

    const estadoInicial = 'ABIERTO';

    const reporte = {
      id: r.id,
      titulo: r.titulo || '',
      descripcion: r.descripcion,
      categoriaId: r.categoriaId,
      ubicacionId: r.ubicacionId,
      creadoPor: r.creadoPor,
      // NUEVO CAMPO: Indica si es un reporte de staff/empleado
      esReporteOficial: r.esReporteOficial || false, 
      estadoActual: estadoInicial,
      createdAt: now,
      updatedAt: now
    };

    saveEncrypted('reportes', reporte.id, reporte);

    const historial = {
      idReporte: reporte.id,
      eventos: [
        {
          fechaHora: now,
          estadoAnterior: null,
          estadoNuevo: estadoInicial,
          comentario: 'Reporte creado',
          usuarioResponsable: r.creadoPor,
          accion: 'CREADO'
        }
      ]
    };

    saveEncrypted('historial', reporte.id, historial);

    res.status(201).json({
      message: 'Reporte creado',
      id: reporte.id
    });
  } catch (err) {
    console.error('Error al crear reporte:', err);
    res.status(500).json({ error: 'Error interno al crear reporte' });
  }
});

// GET /api/reportes/:id
app.get('/api/reportes/:id', (req, res) => {
  const id = req.params.id;

  try {
    const reporte = readEncrypted('reportes', id);
    res.json({ data: reporte });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    console.error('Error al leer reporte:', err);
    res.status(500).json({ error: 'Error interno al leer reporte' });
  }
});

// GET /api/reportes
app.get('/api/reportes', (req, res) => {
  try {
    const reportes = listAllEncrypted('reportes');
    res.json({ data: reportes });
  } catch (err) {
    console.error('Error al listar reportes:', err);
    res.status(500).json({ error: 'Error interno al listar reportes' });
  }
});

// PATCH /api/reportes/:id/estado
// Body: { nuevoEstado, comentario?, usuarioResponsable }
app.patch('/api/reportes/:id/estado', (req, res) => {
  const id = req.params.id;
  const { nuevoEstado, comentario, usuarioResponsable } = req.body;

  if (!nuevoEstado || !usuarioResponsable) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: nuevoEstado, usuarioResponsable'
    });
  }

  if (!ESTADOS_VALIDOS.includes(nuevoEstado)) {
    return res.status(400).json({
      error: `Estado no válido. Debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}`
    });
  }

  const now = new Date().toISOString();

  try {
    const reporte = readEncrypted('reportes', id);

    const estadoAnterior = reporte.estadoActual;
    reporte.estadoActual = nuevoEstado;
    reporte.updatedAt = now;

    saveEncrypted('reportes', id, reporte);

    // Historial
    let historial;
    try {
      historial = readEncrypted('historial', id);
    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        historial = { idReporte: id, eventos: [] };
      } else {
        console.error('Error al leer historial:', err);
        return res.status(500).json({ error: 'Error interno al leer historial' });
      }
    }

    const evento = {
      fechaHora: now,
      estadoAnterior,
      estadoNuevo: nuevoEstado,
      comentario: comentario || '',
      usuarioResponsable,
      accion: 'ESTADO_CAMBIADO'
    };

    historial.eventos.push(evento);
    saveEncrypted('historial', id, historial);

    res.json({
      message: 'Estado de reporte actualizado',
      reporte,
      ultimoEvento: evento
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    console.error('Error al actualizar estado de reporte:', err);
    res.status(500).json({ error: 'Error interno al actualizar estado de reporte' });
  }
});

// GET /api/reportes/:id/historial
app.get('/api/reportes/:id/historial', (req, res) => {
  const id = req.params.id;

  try {
    const historial = readEncrypted('historial', id);
    res.json({ data: historial });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Historial no encontrado' });
    }
    console.error('Error al leer historial:', err);
    res.status(500).json({ error: 'Error interno al leer historial' });
  }
});

// ======================================================
//  EVIDENCIAS (solo metadata, ligada a reporte)
// ======================================================

// POST /api/reportes/:id/evidencias
app.post('/api/reportes/:id/evidencias', (req, res) => {
  const idReporte = req.params.id;
  const { evidenciaId, tipo, nombreArchivo, url, hash, usuarioId } = req.body;

  if (!evidenciaId || !tipo || !nombreArchivo || !url || !usuarioId) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: evidenciaId, tipo, nombreArchivo, url, usuarioId'
    });
  }

  const tiposValidos = ['IMG', 'VIDEO', 'AUDIO', 'DOC'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({
      error: `Tipo de evidencia no válido. Debe ser uno de: ${tiposValidos.join(', ')}`
    });
  }

  const now = new Date().toISOString();

  try {
    // asegurarnos que el reporte exista
    try {
      readEncrypted('reportes', idReporte);
    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Reporte no encontrado' });
      }
      console.error('Error al verificar reporte:', err);
      return res.status(500).json({ error: 'Error interno' });
    }

    // Ver si ya existe la evidencia
    try {
      readEncrypted('evidencias', evidenciaId);
      return res.status(409).json({ error: 'Ya existe una evidencia con ese id' });
    } catch (err) {
      if (err.message !== 'NOT_FOUND') {
        console.error('Error al verificar evidencia existente:', err);
        return res.status(500).json({ error: 'Error interno' });
      }
    }

    const evidencia = {
      id: evidenciaId,
      reporteId: idReporte,
      tipo,
      nombreArchivo,
      url,
      hash: hash || null,
      createdAt: now
    };

    saveEncrypted('evidencias', evidenciaId, evidencia);

    // Actualizar historial
    let historial;
    try {
      historial = readEncrypted('historial', idReporte);
    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        historial = { idReporte, eventos: [] };
      } else {
        console.error('Error al leer historial:', err);
        return res.status(500).json({ error: 'Error interno al leer historial' });
      }
    }

    const evento = {
      fechaHora: now,
      estadoAnterior: null,
      estadoNuevo: null,
      comentario: `Evidencia agregada: ${nombreArchivo}`,
      usuarioResponsable: usuarioId,
      accion: 'EVIDENCIA_AGREGADA'
    };

    historial.eventos.push(evento);
    saveEncrypted('historial', idReporte, historial);

    res.status(201).json({
      message: 'Evidencia registrada',
      evidencia
    });
  } catch (err) {
    console.error('Error al registrar evidencia:', err);
    res.status(500).json({ error: 'Error interno al registrar evidencia' });
  }
});

// GET /api/reportes/:id/evidencias
app.get('/api/reportes/:id/evidencias', (req, res) => {
  const idReporte = req.params.id;

  try {
    const todas = listAllEncrypted('evidencias');
    const filtradas = todas.filter(e => e.reporteId === idReporte);
    res.json({ data: filtradas });
  } catch (err) {
    console.error('Error al listar evidencias:', err);
    res.status(500).json({ error: 'Error interno al listar evidencias' });
  }
});

// ======================================================
//  MÉTRICAS Y PUBLICACIONES EN X (Twitter)
// ======================================================

// GET /api/metricas/mes-actual
app.get('/api/metricas/mes-actual', (req, res) => {
  try {
    const periodo = periodoActual();
    const { metricas, categoriasPorId } = calcularMetricasPorPeriodo(periodo);
    res.json({ periodo, metricas, categoriasPorId });
  } catch (err) {
    console.error('Error al calcular métricas del mes actual:', err);
    res.status(500).json({ error: 'Error interno al calcular métricas' });
  }
});

// GET /api/metricas/:periodo  (periodo = YYYY-MM)
app.get('/api/metricas/:periodo', (req, res) => {
  try {
    const periodo = req.params.periodo;
    const { metricas, categoriasPorId } = calcularMetricasPorPeriodo(periodo);
    res.json({ periodo, metricas, categoriasPorId });
  } catch (err) {
    console.error('Error al calcular métricas del periodo:', err);
    res.status(500).json({ error: 'Error interno al calcular métricas' });
  }
});

// POST /api/publicaciones/x/mes-actual (Disparador manual)
app.post('/api/publicaciones/x/mes-actual', async (req, res) => {
  try {
    const periodo = periodoActual();
    const { metricas, categoriasPorId } = calcularMetricasPorPeriodo(periodo);
    const texto = construirTextoPublicacion(periodo, metricas, categoriasPorId);

    const client = getTwitterClient();
    if (!client || String(TWEET_ENABLE).toLowerCase() === 'false') {
      console.log('📝 Publicación simulada (no se manda a X):\n', texto);
      return res.json({
        ok: true,
        publicado: false,
        periodo,
        metricas,
        texto
      });
    }

    const resTweet = await client.v2.tweet(texto);

    res.json({
      ok: true,
      publicado: true,
      periodo,
      metricas,
      texto,
      tweetId: resTweet.data.id
    });
  } catch (err) {
    console.error('Error al publicar resumen mensual en X:', err);
    res.status(500).json({ ok: false, error: 'Error interno al publicar en X' });
  }
});


app.get('/api/analytics/resumen-manual', async (req, res) => {
  try {
    const p = periodoActual(); 
    console.log(`🚀 Disparador manual para periodo: ${p}`);
    const resultado = await ejecutarPublicacion(p);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// =================== CRON JOB ===================
// Publicación automática el día 1 de cada mes a las 09:00 AM
cron.schedule('0 9 1 * *', async () => {
  try {
    const p = periodoAnterior();
    console.log(`⏰ Cron Job: Generando reporte para periodo CERRADO: ${p}`);
    await ejecutarPublicacion(p);
  } catch (err) {
    console.error('❌ Error cron:', err);
  }
});

// =================== START SERVERS ===================

// 1. Servidor HTTP (Puerto 3000) - Para la App Android y pruebas
app.listen(PORT, () => {
  console.log(`🚀 HTTP Server escuchando en http://0.0.0.0:${PORT} (Ideal para Android)`);
  console.log(`DFS_BASE_PATH -> ${DFS_BASE_PATH}`);
});

// 2. Servidor HTTPS (Puerto 3443) - Para el Dashboard Web Seguro
try {
    const httpsOptions = {
        key: fs.readFileSync('server.key'),
        cert: fs.readFileSync('server.cert')
    };
    
    https.createServer(httpsOptions, app).listen(3443, () => {
        console.log(`HTTPS Server escuchando en https://0.0.0.0:3443 (Ideal para Web)`);
    });
} catch (e) {
    console.log('No se pudo iniciar HTTPS (Faltan certificados server.key/server.cert)');
}
