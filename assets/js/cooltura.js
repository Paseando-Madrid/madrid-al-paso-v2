/* Cooltura — Mosaic + Overlay anchored (premium)
   - NO rompe automatización JSON (/data)
   - Mantiene efecto hover dim/zoom
   - Overlay tipo “hoja” anclada + fondo fantasma (ghost real)
   - Swap premium al cambiar de card (sin brusquedad)
   - Museos: render editorial + pin 📍 (Google Maps “search api=1”)
   - Directo: 8 conciertos + pin 📍 + lista fija de salas recomendadas
   - EXPO: renderer editorial (título bold SIN link + sede + sub-sede + (artistas opcional) + hasta + dirección + pin)
   - EXPO: sedes recomendadas manuales (CaixaForum, MAPFRE, Alcalá 31, Casa Encendida)
   - NIÑOS: formato Expo (título → actividad/audiencia → horario → lugar + pin) + orden: automáticos → manuales
*/

const modal  = document.getElementById('kModal');
const mosaic = document.getElementById('kMosaic');

if (!modal || !mosaic) {
  // No rompe nada si Cooltura no existe en otra página
} else {

  const kTitle = document.getElementById('kTitle');
  const kDeck  = document.getElementById('kDeck');
  const kMeta  = document.getElementById('kMeta');
  const kList  = document.getElementById('kList');

  const cards    = Array.from(document.querySelectorAll('.k-card'));
  const closeBtn = modal.querySelector('.k-close');

  const sheet  = modal.querySelector('.k-sheet');
  const canvas = document.querySelector('.cooltura-canvas');
  const ghost  = modal.querySelector('.k-sheet-ghost');

  const tplMuseo = document.getElementById('tpl-museo');
  const tplPin   = document.getElementById('tpl-pin');

  const CFG = {
    directo:   { title:"Conciertos esta semana",     deck:"Una selección breve para escuchar Madrid en directo.",               json:"data/directo-weekly.json",  mode:"directo" },

    // ✅ NIÑOS (definitivo): semanal, un solo origen (sin fallback)
    ninos:     {
      title:"Disfrutar Madrid con niños",
      deck:"Planes culturales y fáciles para hacerlo con ellos esta semana.",
      json:"data/ninos-weekly.json",
      mode:"kids"
    },

    expo:      { title:"Exposiciones de este mes",   deck:"Salas, museos y montajes que merecen la visita.",                    json:"data/agenda-monthly.json",  mode:"group",  group:"exhibitions" },
    cartelera: { title:"Obras destacadas",           deck:"Teatro en cartel: propuestas con criterio para este mes.",           json:"data/theatre-monthly.json", mode:"items" },
    museos:    { title:"Horarios de museos",         deck:"Horarios, días clave y notas útiles para planificar.",               json:"data/museums.json",         mode:"museos" },
    alargar:   { title:"Para alargar el paseo",      deck:"Mercados, mesas y barras para seguir con Madrid a otro ritmo.",      json:"data/leisure.json",         mode:"items" }
  };

  // Directo: salas recomendadas (editorial)
  const DIRECTO_VENUES = [
    { name: "Sala La Riviera", program: "Conciertos y sesiones de gran formato (rock, pop, electrónica)", address: "Paseo de la Virgen del Puerto, s/n" },
    { name: "Café Berlín", program: "Jazz, soul, funk, blues, world music", address: "Costanilla de los Ángeles, 20" },
    { name: "Teatro Eslava", program: "Conciertos, electrónica, club nights y DJs", address: "Calle del Arenal, 11" },
    { name: "Sala Clamores", program: "Jazz, soul, funk, blues y música afro", address: "Calle de Alburquerque, 14" },
    { name: "Siroko", program: "Electrónica, indie, pop alternativo, DJs", address: "Calle San Dimas, 3" },
    { name: "El Perro de la Parte de Atrás del Coche", program: "Rock, indie y alternativo", address: "Calle Puebla, 15" },
    { name: "Intruso Bar", program: "Blues, funk, soul y jam sessions", address: "Calle de Augusto Figueroa, 3" },
    { name: "Sala El Sol", program: "Rock, indie y alternativo", address: "Calle Jardines, 3" }
  ];

  // EXPO: sedes recomendadas (manuales)
  const EXPO_VENUES = [
    { name: "CaixaForum Madrid", address: "Paseo del Prado, 36" },
    { name: "Fundación MAPFRE",  address: "Paseo de Recoletos, 23" },
    { name: "Sala Alcalá 31",    address: "Calle de Alcalá, 31" },
    { name: "La Casa Encendida", address: "Ronda de Valencia, 2" }
  ];

  // ---------- DIM / ACTIVE ----------
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
    btn.addEventListener('focusin',      () => scheduleActive(btn));
    btn.addEventListener('focusout',     () => scheduleClear());
  });

  mosaic.addEventListener('pointerleave', () => scheduleClear());

  // ---------- OVERLAY: BG + POSITION + HEIGHT ----------
  let anchorCard = null;

  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

  function getCardBgUrl(cardEl){
    const photo = cardEl?.querySelector('.k-photo');
    if(!photo) return null;
    const bg = getComputedStyle(photo).getPropertyValue('background-image');
    if(!bg) return null;
    const v = bg.trim();
    if(v === '' || v === 'none') return null;
    return v; // url("...")
  }

  function setOverlayBgFromCard(cardEl){
    if(!sheet) return;
    const bg = getCardBgUrl(cardEl);
    sheet.style.setProperty('--overlay-bg-url', bg || 'none');
    if(ghost) ghost.style.backgroundImage = bg || 'none';
  }

  function sizeSheetToCanvas(){
    if(!sheet || !canvas) return;
    const cRect = canvas.getBoundingClientRect();
    const pad = 14;
    const desiredH = Math.max(320, cRect.height - pad * 2);
    sheet.style.height = `${desiredH}px`;
  }

  function positionSheetToCard(cardEl){
    if(!sheet || !canvas || !cardEl) return;

    sizeSheetToCanvas();

    const cRect = canvas.getBoundingClientRect();
    const aRect = cardEl.getBoundingClientRect();
    const sRect = sheet.getBoundingClientRect();

    const ax = aRect.left + aRect.width / 2;
    const ay = aRect.top  + aRect.height / 2;

    let left = ax - (sRect.width  / 2);
    let top  = ay - (sRect.height / 2);
    top -= 10;

    const pad = 14;
    const minLeft = cRect.left + pad;
    const maxLeft = cRect.right - pad - sRect.width;
    const minTop  = cRect.top  + pad;
    const maxTop  = cRect.bottom - pad - sRect.height;

    left = clamp(left, minLeft, Math.max(minLeft, maxLeft));
    top  = clamp(top,  minTop,  Math.max(minTop,  maxTop));

    sheet.style.left = `${left}px`;
    sheet.style.top  = `${top}px`;
  }

  function syncOverlayToCard(cardEl){
    anchorCard = cardEl;
    setOverlayBgFromCard(cardEl);
    if(modal.classList.contains('is-open')){
      requestAnimationFrame(() => positionSheetToCard(cardEl));
    }
  }

  // ---------- SWAP ----------
  function beginSwap(){ if(sheet) sheet.classList.add('is-swap'); }
  function endSwap(){
    if(!sheet) return;
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove('is-swap')));
  }

  // ---------- MODAL ----------
  function openModal(){
    if (!modal.classList.contains('is-open')) {
      modal.setAttribute('aria-hidden','false');
      document.body.style.overflow = 'hidden';
      void modal.offsetWidth;

      requestAnimationFrame(() => {
        modal.classList.add('is-open');
        if(anchorCard) positionSheetToCard(anchorCard);
        else sizeSheetToCanvas();
        if(closeBtn) closeBtn.focus({ preventScroll: true });
      });
    } else {
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      if(closeBtn) closeBtn.focus({ preventScroll: true });
    }
  }

  function closeModal(){
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden','true');
    document.body.style.overflow = '';

    if (kList) kList.innerHTML = '';
    clearActive();

    anchorCard = null;
    if(sheet){
      sheet.classList.remove('is-swap');
      sheet.style.removeProperty('--overlay-bg-url');
      sheet.style.removeProperty('left');
      sheet.style.removeProperty('top');
      sheet.style.removeProperty('height');
    }
    if(ghost) ghost.style.backgroundImage = 'none';
  }

  if(closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  function onViewportChange(){
    if(modal.classList.contains('is-open')){
      requestAnimationFrame(() => {
        if(anchorCard) positionSheetToCard(anchorCard);
        else sizeSheetToCanvas();
      });
    }
  }

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', () => {
    if(modal.classList.contains('is-open') && anchorCard){
      requestAnimationFrame(() => positionSheetToCard(anchorCard));
    }
  }, { passive: true });

  // ---------- HELPERS ----------
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

  function safeText(v){ return (v ?? '').toString(); }

  /** ✅ Google Maps con “Guardar” (search api=1) */
  function mapsUrlFromQuery(q){
    const query = safeText(q).trim();
    if(!query) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function isSafeHttpUrl(url){
    try{
      const u = new URL(url, window.location.href);
      return u.protocol === 'http:' || u.protocol === 'https:';
    }catch{
      return false;
    }
  }

  function pinLinkHTML(mapsUrl, ariaLabel){
    const safe = mapsUrl && isSafeHttpUrl(mapsUrl) ? mapsUrl : "";
    if(!safe) return "";

    if(tplPin && 'content' in tplPin){
      const tmp = tplPin.content.firstElementChild.cloneNode(true);
      tmp.href = safe;
      tmp.setAttribute('aria-label', ariaLabel || 'Ver ubicación en Google Maps');
      const wrap = document.createElement('div');
      wrap.appendChild(tmp);
      return wrap.innerHTML;
    }

    return `<a class="pm-pin" href="${safe}" target="_blank" rel="noopener noreferrer" aria-label="${ariaLabel || 'Ver ubicación en Google Maps'}">📍</a>`;
  }

  function normalizeHoursForUI(hours){
    let h = safeText(hours).trim();
    if(!h) return "";
    if (h === "00:00") return "";
    if (/^\d{1,2}:\d{2}$/.test(h)) return ""; // hora suelta poco fiable
    return h;
  }

  // Kids: etiquetas UI (actividad / audiencia / hora)
  function labelActivity(type){
    const t = safeText(type).trim().toLowerCase();
    if(!t) return "";
    const map = {
      "taller": "Taller",
      "teatro": "Teatro",
      "titeres": "Títeres",
      "títeres": "Títeres",
      "visita": "Visita",
      "actividad": "Actividad",
      "familia": "Familia"
    };
    return map[t] || (t.charAt(0).toUpperCase() + t.slice(1));
  }

  function labelAudience(aud){
    const a = safeText(aud).trim().toLowerCase();
    if(!a) return "";
    if(a.includes("niñ")) return "Niños";
    if(a.includes("famil")) return "Familia";
    if(a.includes("todos")) return "Todos los públicos";
    return a.charAt(0).toUpperCase() + a.slice(1);
  }

  function timeFromKidItem(it){
    const time = safeText(it.time).trim();
    if(time) return time;

    const dt = safeText(it.dtstart || it.start).trim();
    // "2026-03-28 11:30:00.0" o ISO -> sacar HH:MM si aparece
    const m = dt.match(/(\d{2}:\d{2})/);
    return m ? m[1] : "";
  }

  // ---------- RENDER (GENÉRICO) ----------
  function renderItems(items){
    const list = Array.isArray(items) ? items : [];
    const max = Math.min(list.length, 8);

    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay recomendaciones publicadas. Vuelve pronto.</p>';
      return;
    }

    kList.innerHTML = list.slice(0, max).map(it => {
      const title = safeText(it.title) || "—";
      const venue = safeText(it.venue);
      const when  = fmtWhen(it.start);

      const metaParts = [venue, when].filter(Boolean);
      const meta = metaParts.join(' · ');

      const maps = safeText(it.mapsUrl) || mapsUrlFromQuery([venue, "Madrid"].filter(Boolean).join(", "));
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${venue || 'este lugar'} en Google Maps`) : "";

      return `
        <div class="k-item">
          <h4>${title}</h4>
          <p>${meta ? `${meta} ${pin ? `· ${pin}` : ""}` : ""}</p>
        </div>
      `;
    }).join('');
  }

  // ---------- RENDER (NIÑOS: Expo-style + automáticos → manuales) ----------
  function renderKidsFromData(data){
    const autoItems =
      (Array.isArray(data?.autoItems) && data.autoItems) ||
      (Array.isArray(data?.items) && data.items) ||
      [];

    const manualItems =
      (Array.isArray(data?.manualItems) && data.manualItems) ||
      (Array.isArray(data?.manual) && data.manual) ||
      [];

    const autoMax = Math.min(autoItems.length, 10);
    const manMax  = Math.min(manualItems.length, 8);

    if(!autoMax && !manMax){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay planes publicados. Vuelve pronto.</p>';
      return;
    }

    function renderKidItemAuto(it){
      const title = safeText(it.title) || "—";

      const venue = safeText(it.venue).trim();
      const space = safeText(it.space || it.subvenue).trim();
      const venueLine = [venue, space].filter(Boolean).join(" · ");

      const addr = safeText(it.address).trim();

      const act = labelActivity(it.type);
      const aud = labelAudience(it.audience);
      const time = timeFromKidItem(it);

      const metaTop = [act, aud].filter(Boolean).join(" · ");
      const metaTime = time ? `🕒 ${time}` : "";

      const q = safeText(it.mapsQuery) || [venueLine || venue, addr, "Madrid"].filter(Boolean).join(", ");
      const maps = safeText(it.mapsUrl) || mapsUrlFromQuery(q);
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${venueLine || venue || 'este lugar'} en Google Maps`) : "";

      return `
        <article class="k-item k-item--kids">
          <div class="k-item-title"><strong>${title}</strong></div>

          ${(metaTop || metaTime) ? `
            <div class="k-item-row k-item-row--meta">
              ${metaTop ? `<span class="k-item-hours">${metaTop}</span>` : `<span></span>`}
              ${metaTime ? `<span class="k-item-metaRight">${metaTime}</span>` : ``}
            </div>
          ` : ``}

          <div class="k-item-row k-item-row--addr">
            <span class="k-item-address">${venueLine || venue || ''}</span>
            ${pin}
          </div>
        </article>
      `;
    }

    function renderKidItemManual(it){
      const title = safeText(it.title) || "—";

      const venue = safeText(it.venue).trim();
      const space = safeText(it.space || it.subvenue).trim();
      const hours = normalizeHoursForUI(it.hours);
      const venueLine = [venue, space].filter(Boolean).join(" · ");

      const addr = safeText(it.address).trim();
      const q = safeText(it.mapsQuery) || [venueLine || venue, addr, "Madrid"].filter(Boolean).join(", ");
      const maps = safeText(it.mapsUrl) || mapsUrlFromQuery(q);
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${venueLine || venue || 'este lugar'} en Google Maps`) : "";

      return `
        <article class="k-item k-item--kids">
          <div class="k-item-title"><strong>${title}</strong></div>
          ${hours ? `<div class="k-item-hours">${hours}</div>` : ``}
          <div class="k-item-row k-item-row--addr">
            <span class="k-item-address">${venueLine || venue || ''}</span>
            ${pin}
          </div>
        </article>
      `;
    }

    let html = "";

    // 1) Automáticos (actividad · audiencia · hora)
    if(autoMax){
      html += autoItems.slice(0, autoMax).map(renderKidItemAuto).join('');
    }

    // 2) Manuales (debajo)
    if(manMax){
      html += `
        <div class="k-divider" aria-hidden="true" style="height:18px;"></div>
        <div class="k-subhead" style="margin-top:10px;">
          <p class="k-kicker" style="margin:0 0 10px 0;">Recomendaciones</p>
        </div>
      `;
      html += manualItems.slice(0, manMax).map(renderKidItemManual).join('');
    }

    kList.innerHTML = html;
  }

  // ---------- RENDER (DIRECTO: items + salas recomendadas) ----------
  function renderDirecto(items){
    renderItems(items);

    const venuesHtml = DIRECTO_VENUES.map(v => {
      const name = safeText(v.name);
      const program = safeText(v.program);
      const address = safeText(v.address);

      const q = [name, address, "Madrid"].filter(Boolean).join(", ");
      const maps = mapsUrlFromQuery(q);
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${name || 'esta sala'} en Google Maps`) : "";

      return `
        <article class="m-item">
          <h4 class="m-title"><strong>${name}</strong></h4>
          ${program ? `<p class="m-row">Programación: ${program}</p>` : ``}
          ${address ? `<p class="m-row m-addr">Dirección: ${address} · ${pin}</p>` : ``}
        </article>
      `;
    }).join('');

    kList.insertAdjacentHTML('beforeend', `
      <div class="k-divider" aria-hidden="true" style="height:18px;"></div>
      <div class="k-subhead" style="margin-top:10px;">
        <p class="k-kicker" style="margin:0 0 10px 0;">Salas recomendadas</p>
      </div>
      <div class="k-venues">
        ${venuesHtml}
      </div>
    `);
  }

  // ---------- RENDER (MUSEOS) ----------
  function renderMuseos(items){
    const list = Array.isArray(items) ? items : [];
    const max  = Math.min(list.length, 10);

    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay museos publicados. Sube <code>data/museums.json</code> y se llenará automáticamente.</p>';
      return;
    }

    if(tplMuseo && 'content' in tplMuseo){
      kList.innerHTML = '';
      const frag = document.createDocumentFragment();

      for(let i=0; i<max; i++){
        const it = list[i] || {};
        const node = tplMuseo.content.firstElementChild.cloneNode(true);

        const titleStrong = node.querySelector('.m-title-strong');
        const rowHours    = node.querySelector('.m-hours');
        const rowFree     = node.querySelector('.m-free');
        const addrText    = node.querySelector('.m-addr-text');
        const addrPin     = node.querySelector('.m-addr-pin');

        const name  = safeText(it.name || it.title);
        const hours = safeText(it.hours || it.openingHours || it.horario);
        const free  = safeText(it.free  || it.freeHours     || it.gratis);
        const addr  = safeText(it.address || it.direccion);

        if(titleStrong) titleStrong.textContent = name || "—";
        if(rowHours) rowHours.textContent = hours ? `Horario: ${hours}` : '';
        if(rowFree)  rowFree.textContent  = free  ? `Día gratuito: ${free}` : '';
        if(addrText) addrText.textContent = addr ? `Dirección: ${addr} · ` : '';

        let maps = safeText(it.mapsUrl || it.maps || it.gmaps);
        if(!maps){
          const q = [name, addr, 'Madrid'].filter(Boolean).join(', ');
          maps = mapsUrlFromQuery(q);
        }
        if(!isSafeHttpUrl(maps)) maps = "";

        if(addrPin){
          addrPin.innerHTML = '';
          if(maps){
            if(tplPin && 'content' in tplPin){
              const pin = tplPin.content.firstElementChild.cloneNode(true);
              pin.href = maps;
              pin.setAttribute('aria-label', `Ver ubicación de ${name || 'este lugar'} en Google Maps`);
              addrPin.appendChild(pin);
            } else {
              const a = document.createElement('a');
              a.className = 'pm-pin';
              a.href = maps;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.setAttribute('aria-label', `Ver ubicación de ${name || 'este lugar'} en Google Maps`);
              a.textContent = '📍';
              addrPin.appendChild(a);
            }
          }
        }

        frag.appendChild(node);
      }

      kList.appendChild(frag);
      return;
    }

    // Fallback
    kList.innerHTML = list.slice(0, max).map(it => {
      const name  = safeText(it.name || it.title) || "—";
      const hours = safeText(it.hours || it.openingHours || it.horario);
      const free  = safeText(it.free  || it.freeHours     || it.gratis);
      const addr  = safeText(it.address || it.direccion);

      let maps = safeText(it.mapsUrl || it.maps || it.gmaps);
      if(!maps){
        const q = [name, addr, 'Madrid'].filter(Boolean).join(', ');
        maps = mapsUrlFromQuery(q);
      }
      if(!isSafeHttpUrl(maps)) maps = "";

      const pin = maps
        ? `<a class="pm-pin" href="${maps}" target="_blank" rel="noopener noreferrer" aria-label="Ver ubicación de ${name} en Google Maps">📍</a>`
        : ``;

      return `
        <article class="m-item">
          <h4 class="m-title"><strong>${name}</strong></h4>
          ${hours ? `<p class="m-row">Horario: ${hours}</p>` : ``}
          ${free ? `<p class="m-row">Día gratuito: ${free}</p>` : ``}
          ${addr ? `<p class="m-row m-addr">Dirección: ${addr} · ${pin}</p>` : ``}
        </article>
      `;
    }).join('');
  }

  // ---------- RENDER (EXPO) ----------
  function renderExpo(items){
    const list = Array.isArray(items) ? items : [];
    const max  = Math.min(list.length, 8);

    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay exposiciones publicadas. Vuelve pronto.</p>';
      return;
    }

    kList.innerHTML = list.slice(0, max).map(it => {
      const title = safeText(it.title) || "—";

      const venue    = safeText(it.venue).trim();
      const subvenue = safeText(it.subvenue || it.space).trim();
      const artists  = safeText(it.artists).trim();

      let hours = safeText(it.hours).trim();
      if (!hours || hours === "00:00" || (/^\d{1,2}:\d{2}$/.test(hours))) {
        hours = "";
      }

      const until = safeText(it.dateText).trim();
      const addr  = safeText(it.address).trim();

      const venueLine = [venue, subvenue].filter(Boolean).join(" · ");

      const q = safeText(it.mapsQuery) || [venue, subvenue, addr, 'Madrid'].filter(Boolean).join(', ');
      const maps = safeText(it.mapsUrl) || mapsUrlFromQuery(q);
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${venueLine || venue || 'esta exposición'} en Google Maps`) : "";

      return `
        <article class="k-item k-item--expo">
          <div class="k-item-title"><strong>${title}</strong></div>

          ${venueLine ? `<div class="k-item-sub">${venueLine}</div>` : ``}
          ${artists ? `<div class="k-item-sub">${artists}</div>` : ``}

          ${(hours || until) ? `
            <div class="k-item-row k-item-row--meta">
              ${hours ? `<span class="k-item-hours">${hours}</span>` : `<span></span>`}
              ${until ? `<span class="k-item-metaRight">${until}</span>` : ``}
            </div>
          ` : ``}

          ${(addr || pin) ? `
            <div class="k-item-row k-item-row--addr">
              ${addr ? `<span class="k-item-address">${addr}</span>` : `<span></span>`}
              ${pin}
            </div>
          ` : ``}
        </article>
      `;
    }).join('');

    const venuesHtml = EXPO_VENUES.map(v => {
      const name = safeText(v.name);
      const address = safeText(v.address);
      const q = [name, address, "Madrid"].filter(Boolean).join(", ");
      const maps = mapsUrlFromQuery(q);
      const pin  = maps ? pinLinkHTML(maps, `Ver ubicación de ${name || 'esta sede'} en Google Maps`) : "";

      return `
        <article class="m-item">
          <h4 class="m-title"><strong>${name}</strong></h4>
          ${address ? `<p class="m-row m-addr">Dirección: ${address} · ${pin}</p>` : ``}
        </article>
      `;
    }).join('');

    kList.insertAdjacentHTML('beforeend', `
      <div class="k-divider" aria-hidden="true" style="height:18px;"></div>
      <div class="k-subhead" style="margin-top:10px;">
        <p class="k-kicker" style="margin:0 0 10px 0;">Sedes recomendadas</p>
      </div>
      <div class="k-venues">
        ${venuesHtml}
      </div>
    `);
  }

  // ---------- LOAD + RENDER ----------
  async function fetchJsonWithFallback(primary, fallback){
    const tryFetch = async (url) => {
      const res = await fetch(url, { cache: 'no-store' });
      if(!res.ok) throw new Error(`fetch failed: ${url}`);
      return res.json();
    };

    try{
      return await tryFetch(primary);
    }catch(err){
      if(!fallback) throw err;
      return await tryFetch(fallback);
    }
  }

  async function loadAndRender(key){
    const cfg = CFG[key];
    if(!cfg) return;

    beginSwap();

    kTitle.textContent = cfg.title;
    kDeck.textContent  = cfg.deck;
    kMeta.textContent  = 'Cargando…';
    kList.innerHTML = '';

    openModal();

    try{
      const data = await fetchJsonWithFallback(cfg.json, cfg.fallbackJson);

      const updated = data.updatedAt ? fmtDate(data.updatedAt) : "—";
      kMeta.textContent = `Actualizado: ${updated}`;

      if(cfg.mode === "museos"){
        renderMuseos(Array.isArray(data.items) ? data.items : []);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "directo"){
        renderDirecto(Array.isArray(data.items) ? data.items : []);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "kids"){
        renderKidsFromData(data);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "items"){
        renderItems(Array.isArray(data.items) ? data.items : []);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "group"){
        const groups = Array.isArray(data.groups) ? data.groups : [];
        const g = groups.find(x => x.category === cfg.group);

        if(cfg.group === "exhibitions"){
          kDeck.textContent = "Programación en Madrid · Sedes culturales";
          renderExpo(Array.isArray(g?.items) ? g.items : []);
        } else {
          if(g?.deck) kDeck.textContent = g.deck;
          renderItems(Array.isArray(g?.items) ? g.items : []);
        }

        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      kList.innerHTML = '<p class="k-empty">No hay datos disponibles.</p>';
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      endSwap();
    } catch {
      kMeta.textContent = 'No se pudo cargar la información.';
      kList.innerHTML = '<p class="k-empty">Cuando subas los JSON en /data, este overlay se llenará automáticamente.</p>';
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      endSwap();
    }
  }

  // ---------- CLICK CARDS ----------
  cards.forEach(btn => {
    btn.addEventListener('click', () => {
      clearTimeout(hoverTimer);
      clearTimeout(clearTimer);

      setActiveCard(btn);
      syncOverlayToCard(btn);

      const family = btn.dataset.family;
      loadAndRender(family);
    });
  });

}
