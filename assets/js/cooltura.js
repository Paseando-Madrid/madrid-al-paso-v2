/* Cooltura — Mosaic + Modal (premium) */

const modal  = document.getElementById('kModal');
const mosaic = document.getElementById('kMosaic');

if (!modal || !mosaic) {
  // Si algún día cambias HTML o cargas otra página sin Cooltura,
  // este JS no debe romper nada.
  // (No hace nada y se sale)
} else {

  const kTitle = document.getElementById('kTitle');
  const kDeck  = document.getElementById('kDeck');
  const kMeta  = document.getElementById('kMeta');
  const kList  = document.getElementById('kList');

  const cards = Array.from(document.querySelectorAll('.k-card'));
  const closeBtn = modal.querySelector('.k-close');

  const CFG = {
    directo:   { title:"Conciertos esta semana", deck:"Una selección breve para escuchar Madrid en directo.", json:"data/agenda-weekly.json",  mode:"items" },
    ninos:     { title:"Disfrutar Madrid con niños", deck:"Planes culturales y fáciles para hacerlo con ellos esta semana.", json:"data/kids-weekly.json", mode:"items" },
    expos:     { title:"Exposiciones de este mes", deck:"Salas, museos y montajes que merecen la visita.", json:"data/agenda-monthly.json", mode:"group", group:"exhibitions" },
    cartelera: { title:"Obras destacadas", deck:"Teatro en cartel: propuestas con criterio para este mes.", json:"data/agenda-monthly.json", mode:"group", group:"theatre" },
    museo:     { title:"Horarios de museos", deck:"Horarios, días clave y notas útiles para planificar.", json:"data/museums.json", mode:"items" },
    alarga:    { title:"Para alargar el paseo", deck:"Mercados, mesas y barras para seguir con Madrid a otro ritmo.", json:"data/leisure.json", mode:"items" }
  };

  /* ==========
     DIM / ACTIVE
  ========== */
  let hoverTimer = null;
  let clearTimer = null;

  function setActiveCard(card){
    cards.forEach(c => c.classList.toggle('is-active', c === card));
    mosaic.classList.add('is-dim');
  }

  function clearActive(){
    cards.forEach(c => c.classList.remove('is-active'));
    mosaic.classList.remove('is-dim');
  }

  function scheduleActive(card){
    clearTimeout(clearTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setActiveCard(card), 60);
  }

  function scheduleClear(){
    clearTimeout(hoverTimer);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if(!modal.classList.contains('is-open')) clearActive();
    }, 140);
  }

  cards.forEach(btn => {
    btn.addEventListener('pointerenter', () => scheduleActive(btn));
    btn.addEventListener('pointerleave', () => scheduleClear());
    btn.addEventListener('focusin', () => scheduleActive(btn));
    btn.addEventListener('focusout', () => scheduleClear());
  });

  mosaic.addEventListener('pointerleave', () => scheduleClear());

  /* ==========
     MODAL
     - sin display:none
     - tempo premium (blur->focus)
  ========== */
  function openModal(){
    // Si ya está abierto, no “reiniciamos” la animación: solo mantenemos estado.
    if (!modal.classList.contains('is-open')) {
      modal.setAttribute('aria-hidden','false');
      document.body.style.overflow = 'hidden';

      // Reflow para que el navegador registre el estado cerrado
      void modal.offsetWidth;

      requestAnimationFrame(() => {
        modal.classList.add('is-open');
        if(closeBtn) closeBtn.focus({ preventScroll: true });
      });
    } else {
      // ya abierto: foco al botón por accesibilidad, sin reanimar
      if(closeBtn) closeBtn.focus({ preventScroll: true });
    }
  }

  function closeModal(){
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden','true');
    document.body.style.overflow = '';
    if (kList) kList.innerHTML = '';
    clearActive();
  }

  document.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', closeModal)
  );

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  function fmtDate(d){
    try { return new Date(d).toLocaleDateString('es-ES', { year:'numeric', month:'short', day:'2-digit' }); }
    catch { return "—"; }
  }

  function fmtWhen(start){
    if(!start) return "";
    try {
      return new Date(start).toLocaleString('es-ES', {
        weekday:'short', day:'2-digit', month:'short',
        hour:'2-digit', minute:'2-digit'
      });
    } catch { return ""; }
  }

  function renderItems(items){
    const max = Math.min(items.length, 8);
    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay recomendaciones publicadas. Vuelve pronto.</p>';
      return;
    }

    kList.innerHTML = items.slice(0, max).map(it => {
      const place = [it.venue, it.area].filter(Boolean).join(' · ');
      const when  = fmtWhen(it.start);
      const meta  = [place, when].filter(Boolean).join(' · ');
      const desc  = it.excerpt ? it.excerpt : meta;

      return `
        <div class="k-item">
          <h4>${it.title || "—"}</h4>
          <p>${desc || ""}</p>
          ${it.url ? `<a href="${it.url}" target="_blank" rel="noopener">Ver detalles →</a>` : ``}
        </div>
      `;
    }).join('');
  }

  async function loadAndRender(key){
    const cfg = CFG[key];
    if(!cfg) return;

    kTitle.textContent = cfg.title;
    kDeck.textContent  = cfg.deck;
    kMeta.textContent  = 'Cargando…';
    kList.innerHTML = '';

    openModal();

    try{
      const res = await fetch(cfg.json, { cache: 'no-store' });
      if(!res.ok) throw new Error("fetch failed");
      const data = await res.json();

      const updated = data.updatedAt ? fmtDate(data.updatedAt) : "—";
      kMeta.textContent = `Actualizado: ${updated}`;

      if(cfg.mode === "items"){
        renderItems(Array.isArray(data.items) ? data.items : []);
        return;
      }

      if(cfg.mode === "group"){
        const groups = Array.isArray(data.groups) ? data.groups : [];
        const g = groups.find(x => x.category === cfg.group);
        if(g?.deck) kDeck.textContent = g.deck;
        renderItems(Array.isArray(g?.items) ? g.items : []);
        return;
      }

      kList.innerHTML = '<p class="k-empty">No hay datos disponibles.</p>';
    } catch {
      kMeta.textContent = 'No se pudo cargar la información.';
      kList.innerHTML = '<p class="k-empty">Cuando subas los JSON en /data, este overlay se llenará automáticamente.</p>';
    }
  }

  /* ==========
     Click cards
     - cancela timers para que nada “limpie” tras click
     - permite cambiar de card con modal abierto sin parpadeos
  ========== */
  cards.forEach(btn => {
    btn.addEventListener('click', () => {
      clearTimeout(hoverTimer);
      clearTimeout(clearTimer);

      setActiveCard(btn);
      loadAndRender(btn.dataset.open);
    });
  });

}

