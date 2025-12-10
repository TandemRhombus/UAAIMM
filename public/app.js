gsap.registerPlugin(ScrollTrigger);

const API_URL = window.location.origin + '/api';
let reportsData = [];
let categoryMap = {};
let locationMap = {};
let categoryChart = null;
let statusChart = null;
let currentReportId = null;

document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    gsap.from(".login-container", { y: 50, opacity: 0, duration: 1, ease: "power3.out" });
    
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateEl = document.getElementById('current-date');
    if(dateEl) dateEl.textContent = new Date().toLocaleDateString('es-MX', options);
});

// === LOGIC SYSTEM LOGS ===
function addSystemLog(msg, type='info') {
    const term = document.getElementById('system-logs');
    if(!term) return;
    
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const div = document.createElement('div');
    div.className = 'log-line';
    
    gsap.fromTo(div, {opacity: 0, x: -20}, {opacity: 1, x: 0, duration: 0.3});
    div.innerHTML = `<span class="time">[${time}]</span> <span class="log-msg ${type}">${msg}</span>`;
    term.prepend(div);
}

// === HEALTH CHECK REALISTA ===
window.checkSystemHealth = async () => {
    // CORRECCIÓN: Usamos la clase correcta que está en el HTML
    const btn = document.querySelector('.btn-scan'); 
    
    if(!btn) return; // Protección por si acaso
    
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="material-icons-round spin">sync</span> Verificando...';
    
    addSystemLog('Iniciando handshake con servidor App1...', 'info');
    
    try {
        const start = Date.now();
        const res = await fetch(`${API_URL}/health`);
        const latency = Date.now() - start;
        
        if(res.ok) {
            const data = await res.json();
            
            addSystemLog(`Backend App1 respondió en ${latency}ms`, 'success');
            
            // HDFS REAL
            const hdfsStatus = data.hdfsStatus || "OFFLINE";
            const elHdfs = document.getElementById('hdfs-status');
            const dotHdfs = document.getElementById('sys-hdfs').querySelector('.dot');
            
            if(hdfsStatus === 'ONLINE') {
                elHdfs.innerText = "ONLINE (TCP 9000)";
                elHdfs.className = "sys-status status-ok";
                dotHdfs.className = "dot green";
                addSystemLog('HDFS NameNode accesible vía TCP', 'success');
            } else {
                elHdfs.innerText = "OFFLINE";
                elHdfs.className = "sys-status status-error";
                dotHdfs.className = "dot red";
                addSystemLog('HDFS NameNode no responde', 'danger');
            }

            // DRIVE REAL (Basado en logs)
            const driveStatus = data.driveStatus || "NO_LOG";
            const elDrive = document.getElementById('sys-drive').querySelector('.sys-status'); // Ajusta según tu HTML si tiene ID
            // Si no tiene ID específico, buscamos en el contenedor
            // Asumiendo que el HTML es estático, lo inyectamos:
            // (Mejor usa IDs en el HTML para evitar errores, pero esto funciona con tu estructura actual)
            const driveContainer = document.getElementById('sys-drive');
            const driveBadge = driveContainer.querySelector('.sys-status');
            const driveDot = driveContainer.querySelector('.dot');

            if(driveStatus === 'SYNCED') {
                driveBadge.innerText = "SINCRONIZADO";
                driveBadge.className = "sys-status status-ok";
                driveDot.className = "dot blue";
                addSystemLog('Log de Rclone actualizado (<24h)', 'success');
            } else {
                driveBadge.innerText = "DESFASADO";
                driveBadge.className = "sys-status status-warn";
                driveDot.className = "dot yellow";
                addSystemLog('Advertencia: Log de Rclone antiguo o inexistente', 'warn');
            }

            Swal.fire({
                icon: 'success', title: 'Diagnóstico Completado', 
                text: `Latencia: ${latency}ms`,
                background: '#1e293b', color: '#fff', timer: 1500, showConfirmButton: false
            });

        } else { throw new Error("Backend error"); }
    } catch(e) {
        
    }
    btn.innerHTML = originalText;
};

// === AUTH ===
const loginForm = document.getElementById('login-form');
if(loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('login-id').value;
        const password = document.getElementById('login-pass').value;

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ id, password })
            });
            const data = await res.json();
            
            if(res.ok) {
                const user = data.usuario;
                const rol = user.rol || "";
                if (rol.toLowerCase().includes('empleado') || rol.toLowerCase().includes('admin')) {
                    localStorage.setItem('uaa_user', JSON.stringify(user));
                    Swal.fire({
                        icon: 'success', title: '¡Bienvenido!', text: `Hola, ${user.nombre}`,
                        timer: 1500, showConfirmButton: false, background: '#1e293b', color: '#fff'
                    }).then(() => enterApp());
                } else {
                    Swal.fire({icon: 'error', title: 'Acceso Denegado', text: 'Solo personal administrativo.', background: '#1e293b', color: '#fff'});
                }
            } else {
                Swal.fire({icon: 'error', title: 'Error', text: data.error, background: '#1e293b', color: '#fff'});
                gsap.to(".login-container", { x: 10, duration: 0.1, yoyo: true, repeat: 5 });
            }
        } catch(err) {
            Swal.fire({icon: 'error', title: 'Sin conexión', text: 'Backend no responde', background: '#1e293b', color: '#fff'});
        }
    });
}

function checkSession() {
    const user = JSON.parse(localStorage.getItem('uaa_user'));
    if(user) enterApp();
}

function enterApp() {
    const user = JSON.parse(localStorage.getItem('uaa_user'));
    document.getElementById('login-view').classList.remove('active-view');
    document.getElementById('app-view').classList.add('active-view');
    
    // Llenar datos de usuario
    document.getElementById('display-id').innerText = user.id;
    document.getElementById('display-role').innerText = user.rol || "Staff";
    
    if(document.getElementById('conf-name')) {
        document.getElementById('conf-name').innerText = user.nombre;
        document.getElementById('conf-id').innerText = user.id;
        document.getElementById('conf-email').innerText = user.correo;
        document.getElementById('conf-rol').innerText = user.rol;
    }

    addSystemLog(`Sesión iniciada: ${user.id} (${user.rol})`, 'success');
    
    // Cargar datos de reportes
    loadData();
    
    // [IMPORTANTE] EJECUTAR EL CHEQUEO DE SISTEMA AUTOMÁTICAMENTE
    // Esto quita el "Verificando..." y pone el estado real al entrar.
    setTimeout(() => {
        checkSystemHealth();
    }, 1000); // Pequeño delay para que se vea la animación de entrada primero
    
    // Animaciones de entrada Dashboard
    if (typeof gsap !== 'undefined') {
        gsap.from(".sidebar", { x: -100, duration: 0.8, ease: "power2.out" });
        gsap.from(".top-bar", { y: -20, opacity: 0, delay: 0.2 });
        gsap.from(".setting-card", { y: 30, opacity: 0, stagger: 0.1, duration: 0.6, delay: 0.4, ease: "back.out(1.2)" });
    }
}

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('uaa_user');
    location.reload();
});

// === DATA LOGIC & ANIMATIONS ===
async function loadData() {
    // Animación de carga (Fade Out temporal)
    gsap.to([".stats-row", ".table-wrapper", ".charts-row"], {opacity: 0.5, duration: 0.2});

    try {
        const resCat = await fetch(`${API_URL}/categorias`);
        const dataCat = await resCat.json();
        categoryMap = {};
        if(dataCat.data) dataCat.data.forEach(c => categoryMap[c.id] = c.nombre);

        const resLoc = await fetch(`${API_URL}/ubicaciones`);
        const dataLoc = await resLoc.json();
        locationMap = {};
        if(dataLoc.data) dataLoc.data.forEach(l => locationMap[l.id] = l);

        const resRep = await fetch(`${API_URL}/reportes`);
        const dataRep = await resRep.json();
        
        if(dataRep.data) {
            reportsData = dataRep.data.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
            updateDashboard();
            renderReportsGrid(reportsData);
            
            // Animación de entrada (Fade In)
            gsap.to([".stats-row", ".table-wrapper", ".charts-row"], {opacity: 1, duration: 0.5});
            addSystemLog('Datos actualizados correctamente', 'info');
        }
    } catch(e) { console.error(e); addSystemLog('Error al cargar datos', 'danger'); }
}

function updateDashboard() {
    const total = reportsData.length;
    const pending = reportsData.filter(r => ['ABIERTO', 'EN_ATENCION'].includes(r.estadoActual)).length;
    const solved = reportsData.filter(r => ['RESUELTO', 'CERRADO'].includes(r.estadoActual)).length;

    // Contadores animados
    gsap.fromTo('#stat-total', {innerText: 0}, {innerText: total, snap: "innerText", duration: 1.5, ease: "power1.out"});
    gsap.fromTo('#stat-pending', {innerText: 0}, {innerText: pending, snap: "innerText", duration: 1.5, ease: "power1.out"});
    gsap.fromTo('#stat-solved', {innerText: 0}, {innerText: solved, snap: "innerText", duration: 1.5, ease: "power1.out"});

    const tbody = document.getElementById('recent-table-body');
    if (tbody) {
        tbody.innerHTML = '';
        reportsData.slice(0, 5).forEach(r => {
            const tr = document.createElement('tr');
            const loc = locationMap[r.ubicacionId];
            const locText = loc ? loc.area : "Desconocida";
            tr.innerHTML = `
                <td class="mono" style="color: #94a3b8;">${r.id.substring(0,6)}</td>
                <td>${r.titulo}</td>
                <td>${locText}</td>
                <td><span class="badge ${r.estadoActual}">${r.estadoActual}</span></td>
            `;
            tbody.appendChild(tr);
        });
        // Stagger animation para la tabla
        gsap.from("#recent-table-body tr", {opacity: 0, x: -20, stagger: 0.1, duration: 0.4});
    }
    renderCharts();
}

function renderReportsGrid(data) {
    const grid = document.getElementById('all-reports-grid');
    if (!grid) return;
    grid.innerHTML = '';

    data.forEach((r) => {
        const card = document.createElement('div');
        card.className = `report-card ${r.esReporteOficial ? 'official' : ''}`;
        
        const loc = locationMap[r.ubicacionId];
        const locText = loc ? loc.area : "Ubicación desconocida";

        card.innerHTML = `
            <div class="rc-header">
                <span class="badge ${r.estadoActual}">${r.estadoActual}</span>
                <small>${new Date(r.createdAt).toLocaleDateString()}</small>
            </div>
            <div class="rc-title">${r.titulo}</div>
            <div class="rc-desc" style="color: #3b82f6; font-weight: 500; font-size: 0.85rem; margin-bottom: 5px;">
                <span class="material-icons-round" style="font-size: 14px; vertical-align: middle;">place</span> ${locText}
            </div>
            <div class="rc-desc">${categoryMap[r.categoriaId] || 'General'}</div>
            <div style="margin-top: 10px; font-size: 0.8rem; color: #64748b">
                ${r.esReporteOficial ? '⭐ Reporte Oficial' : '👤 Alumno'}
            </div>
        `;
        card.onclick = () => window.openModal(r);
        grid.appendChild(card);
    });

    ScrollTrigger.batch(".report-card", {
        onEnter: batch => gsap.to(batch, {opacity: 1, y: 0, stagger: 0.1, duration: 0.4}),
        start: "top 90%"
    });
}

// Filtros
const searchInput = document.getElementById('search-input');
if(searchInput) {
    searchInput.addEventListener('keyup', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = reportsData.filter(r => r.titulo.toLowerCase().includes(term) || r.descripcion.toLowerCase().includes(term));
        renderReportsGrid(filtered);
    });
}
const filterStatus = document.getElementById('filter-status');
if(filterStatus) {
    filterStatus.addEventListener('change', (e) => {
        const status = e.target.value;
        const filtered = status === 'ALL' ? reportsData : reportsData.filter(r => r.estadoActual === status);
        renderReportsGrid(filtered);
    });
}

// === MODAL ===
window.openModal = (r) => {
    if (typeof r === 'string') r = reportsData.find(x => x.id === r);
    if (!r) return;
    currentReportId = r.id;

    document.getElementById('m-title').innerText = r.titulo;
    document.getElementById('m-id').innerText = r.id;
    document.getElementById('m-author').innerText = r.creadoPor + (r.esReporteOficial ? " (Empleado)" : "");
    document.getElementById('m-desc').innerText = r.descripcion;
    document.getElementById('m-date').innerText = new Date(r.createdAt).toLocaleString();

    const loc = locationMap[r.ubicacionId];
    document.getElementById('m-loc').innerText = loc ? `${loc.area} (${loc.lat}, ${loc.lng})` : r.ubicacionId;
    document.getElementById('m-chips').innerHTML = `<span class="badge ${r.estadoActual}">${r.estadoActual}</span>`;

    const modal = document.getElementById('modal-overlay');
    modal.style.display = 'flex';
    gsap.fromTo(".modal", {scale: 0.8, opacity:0}, {scale: 1, opacity:1, duration: 0.3, ease: "back.out(1.7)"});
};

window.closeModal = () => {
    const modal = document.getElementById('modal-overlay');
    gsap.to(".modal", {scale: 0.8, opacity:0, duration: 0.2, onComplete: () => modal.style.display = 'none'});
};

window.updateStatus = async (newStatus) => {
    if(!currentReportId) return;
    try {
        const body = { 
            nuevoEstado: newStatus, 
            comentario: "Web Admin Action", 
            usuarioResponsable: JSON.parse(localStorage.getItem('uaa_user')).id 
        };
        const res = await fetch(`${API_URL}/reportes/${currentReportId}/estado`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (res.ok) {
            Swal.fire({
                icon: 'success', title: 'Actualizado',
                text: `Estado cambiado a ${newStatus}`,
                timer: 1000, showConfirmButton: false,
                background: '#1e293b', color: '#fff'
            });
            addSystemLog(`Reporte ${currentReportId} cambiado a ${newStatus}`, 'success');
            closeModal();
            loadData();
        } else { throw new Error(); }
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo actualizar', background: '#1e293b', color: '#fff' });
    }
};

// === NAVIGATION TABS ===
const navItems = document.querySelectorAll('.nav-item');
const sections = document.querySelectorAll('.content-section');

navItems.forEach(btn => {
    btn.addEventListener('click', () => {
        navItems.forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
        
        const target = btn.dataset.target;
        gsap.to(".content-section.active", {opacity: 0, y: -10, duration: 0.2, onComplete: () => {
            sections.forEach(s => s.classList.remove('active'));
            const newSection = document.getElementById(target);
            newSection.classList.add('active');
            gsap.fromTo(newSection, {opacity: 0, y: 10}, {opacity: 1, y: 0, duration: 0.4});
            
            if(target === 'reports-section') renderReportsGrid(reportsData);
        }});
        
        document.getElementById('sidebar').classList.remove('open');
    });
});

document.getElementById('btn-menu-toggle').addEventListener('click', () => { document.getElementById('sidebar').classList.add('open'); });
document.getElementById('btn-menu-close').addEventListener('click', () => { document.getElementById('sidebar').classList.remove('open'); });

// === CHARTS ===
function renderCharts() {
    const ctx1 = document.getElementById('categoryChart');
    const ctx2 = document.getElementById('statusChart');
    if(!ctx1 || !ctx2) return;

    const catCounts = {};
    reportsData.forEach(r => { const c = categoryMap[r.categoriaId] || "Otros"; catCounts[c] = (catCounts[c]||0)+1; });
    
    if(categoryChart) categoryChart.destroy();
    categoryChart = new Chart(ctx1.getContext('2d'), {
        type: 'bar',
        data: {
            labels: Object.keys(catCounts),
            datasets: [{ label: 'Incidentes', data: Object.values(catCounts), backgroundColor: '#3b82f6', borderRadius: 6 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: {legend:{display:false}}, scales:{y:{beginAtZero:true}} }
    });
    
    const statusCounts = { 'Pendientes':0, 'Resueltos':0 };
    reportsData.forEach(r => { 
        if(['RESUELTO','CERRADO'].includes(r.estadoActual)) statusCounts['Resueltos']++; else statusCounts['Pendientes']++;
    });
    
    if(statusChart) statusChart.destroy();
    statusChart = new Chart(ctx2.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: Object.keys(statusCounts),
            datasets: [{ data: Object.values(statusCounts), backgroundColor: ['#ef4444', '#10b981'], borderWidth:0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: {legend:{position:'bottom', labels:{color:'#94a3b8'}}} }
    });
}
