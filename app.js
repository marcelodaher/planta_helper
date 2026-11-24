import { solve, validate, engineList } from "./generator.mjs";
import { FACADES } from "./layout.mjs";
import { samples } from "./samples.mjs";

const roomList = document.querySelector("#rooms");
const message = document.querySelector("#message");
const results = document.querySelector("#results");
const roomDialog = document.querySelector("#room-dialog");
const roomForm = document.querySelector("#room-form");
const removeRoom = document.querySelector("#remove-room");
const undoRemove = document.querySelector("#undo-remove");
const connectionGraph = document.querySelector("#connection-graph");
const graphDialog = document.querySelector("#graph-dialog");
const graphLarge = document.querySelector("#graph-large");
const engineSelect = document.querySelector("#engine");
const engineDescription = document.querySelector("#engine-description");
let roomData = [];
let editingIndex = null;
let dragIndex = null;
let removedRooms = null;
// Bottom gallery: extra topologies revealed a batch at a time.
const ALTERNATIVE_BATCH = 4;
let bestOptions = [];
let alternatives = [];
let shownAlternatives = 0;

// Fill the engine dropdown from the shared registry.
engineSelect.innerHTML = engineList.map(engine =>
  `<option value="${escapeHTML(engine.id)}">${escapeHTML(engine.label)}</option>`).join("");
engineSelect.addEventListener("change", () => {
  engineDescription.textContent = engineList.find(engine => engine.id === engineSelect.value)?.description ?? "";
  saveState();
});
engineDescription.textContent = engineList[0].description;

// Theme: index.html picks the saved or system theme before first paint; the
// switch flips it and remembers the choice. Diagrams keep light paper.
const themeToggle = document.querySelector("#theme-toggle");
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggle.checked = dark;
}
applyTheme(document.documentElement.dataset.theme === "dark");
themeToggle.addEventListener("change", () => {
  const dark = themeToggle.checked;
  try { localStorage.setItem("planta-theme", dark ? "dark" : "light"); } catch {}
  applyTheme(dark);
});

// Show a full-page wait overlay while work is running.
function setBusy(text) {
  document.querySelector("#busy-text").textContent = text;
  document.querySelector("#busy-overlay").hidden = false;
}

function clearBusy() {
  document.querySelector("#busy-overlay").hidden = true;
}

// Escape values before placing them in HTML templates.
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

// Show the current rooms as a draggable list with no inline editing controls.
function renderRoomList() {
  roomList.innerHTML = roomData.map((room, index) => {
    const facades = (room.facades ?? []).map(facade => FACADES[facade]).join(", ");
    const tags = [room.corridor && "corredor", room.void && "vazado", facades ? `fachadas: ${facades}` : room.exterior && "área externa"].filter(Boolean);
    const details = `${room.minArea}–${room.maxArea} m² · lado mínimo ${room.minSide} m${tags.length ? ` · ${tags.join(" · ")}` : ""}`;
    return `<li class="color-${escapeHTML(room.color ?? "gray")}" draggable="true" tabindex="0" data-index="${index}" aria-label="Editar ${escapeHTML(room.name)}; arraste para reordenar">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="room-summary"><strong>${escapeHTML(room.name)}</strong><small>${escapeHTML(details)}</small></span>
    </li>`;
  }).join("");
  renderConnectionGraph();
  saveState();
}

// Position graph nodes with springs and repulsion, then separate overlapping bubbles.
function arrangeGraph(rooms, links) {
  const SPACING = 82;
  const ring = SPACING * Math.sqrt(rooms.length);
  const nodes = rooms.map((room, index) => ({
    ...room,
    x: ring * Math.cos((Math.PI * 2 * index / rooms.length) - Math.PI / 2),
    y: ring * Math.sin((Math.PI * 2 * index / rooms.length) - Math.PI / 2),
  }));
  if (nodes.length === 1) return nodes;
  for (let step = 0; step < 120; step++) {
    const forces = nodes.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const strength = 2500 / (distance * distance);
        forces[i].x += dx / distance * strength;
        forces[i].y += dy / distance * strength;
        forces[j].x -= dx / distance * strength;
        forces[j].y -= dy / distance * strength;
      }
    }
    for (const [from, to] of links) {
      const dx = nodes[to].x - nodes[from].x;
      const dy = nodes[to].y - nodes[from].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (distance - SPACING * 1.3) * 0.05;
      forces[from].x += dx / distance * strength;
      forces[from].y += dy / distance * strength;
      forces[to].x -= dx / distance * strength;
      forces[to].y -= dy / distance * strength;
    }
    nodes.forEach((node, index) => {
      node.x += forces[index].x;
      node.y += forces[index].y;
    });
  }
  // Push any remaining overlapping bubbles apart so every circle stays readable.
  for (let step = 0; step < 400; step++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) { dx = 0.001 * (i - j); dy = 0.001; distance = Math.hypot(dx, dy); }
        if (distance >= SPACING) continue;
        const push = (SPACING - distance) / 2;
        nodes[i].x += dx / distance * push;
        nodes[i].y += dy / distance * push;
        nodes[j].x -= dx / distance * push;
        nodes[j].y -= dy / distance * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return nodes;
}

// Draw the bidirectional room links as a small, dependency-free SVG graph.
function renderConnectionGraph() {
  if (!roomData.length) {
    connectionGraph.innerHTML = "<p>Nenhum cômodo adicionado.</p>";
    return;
  }
  const colors = {
    green: "#dcebe0", blue: "#dbeaf5", yellow: "#f6e8c9", orange: "#f8dfc8",
    purple: "#e9ddf3", pink: "#f5dce6", gray: "#e4e7e5",
  };
  const indexes = new Map(roomData.map((room, index) => [room.name, index]));
  const links = roomData.flatMap((room, index) => room.links
    .map(name => indexes.get(name))
    .filter(peer => peer > index)
    .map(peer => [index, peer]));
  const points = arrangeGraph(roomData, links);
  const radius = 34;
  const minX = Math.min(...points.map(point => point.x)) - radius - 12;
  const minY = Math.min(...points.map(point => point.y)) - radius - 12;
  const maxX = Math.max(...points.map(point => point.x)) + radius + 12;
  const maxY = Math.max(...points.map(point => point.y)) + radius + 12;
  const edges = links.map(([from, to]) => `<line x1="${points[from].x}" y1="${points[from].y}" x2="${points[to].x}" y2="${points[to].y}"/>`);
  connectionGraph.innerHTML = `<svg viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" role="img" aria-label="Grafo de conexões bidirecionais entre cômodos">
    <g class="graph-edges">${edges.join("")}</g>
    <g>${points.map(point => {
      const label = point.name.length > 11 ? `${point.name.slice(0, 10)}…` : point.name;
      return `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${colors[point.color] ?? colors.gray}"/><title>${escapeHTML(point.name)}</title>
        <text x="${point.x}" y="${point.y}" text-anchor="middle" dominant-baseline="middle">${escapeHTML(label)}</text>`;
    }).join("")}</g>
  </svg>`;
}

// Open the sidebar graph as a full-page overlay.
function openGraph() {
  graphLarge.innerHTML = connectionGraph.innerHTML;
  graphDialog.showModal();
}

// Populate the checkboxes for the rooms this room can connect to.
function renderConnections(room) {
  const links = new Set(room?.links ?? []);
  document.querySelector("#connections").innerHTML = roomData
    .filter((other, index) => index !== editingIndex)
    .map(other => `<label class="inline-check"><input type="checkbox" name="links" value="${escapeHTML(other.name)}" ${links.has(other.name) ? "checked" : ""}> ${escapeHTML(other.name)}</label>`)
    .join("") || "<p>Adicione outro cômodo para definir conexões.</p>";
}

// Reflect the selected room color on the swatch inside the dropdown.
function showColorSample() {
  document.querySelector("#color-swatch").dataset.color = roomForm.elements.color.value;
}

// A named facade already implies exterior contact, so the general checkbox follows it.
function syncExterior() {
  const chosen = Boolean(roomForm.querySelector('input[name="facades"]:checked'));
  const box = roomForm.elements.exterior;
  box.checked = chosen || box.checked;
  box.disabled = chosen;
}

// Open the separate editor for adding or editing one room.
function openRoomEditor(index, corridor = false) {
  editingIndex = index;
  const room = index === null ? {
    name: corridor ? "corredor" : "",
    minArea: 8,
    maxArea: 12,
    minSide: 1.2,
    corridor,
    void: false,
    exterior: !corridor,
    color: "gray",
    links: [],
  } : roomData[index];
  roomForm.reset();
  roomForm.elements.name.value = room.name;
  roomForm.elements.minArea.value = room.minArea ?? "";
  roomForm.elements.maxArea.value = room.maxArea ?? "";
  roomForm.elements.minSide.value = room.minSide ?? "";
  roomForm.elements.corridor.checked = Boolean(room.corridor);
  roomForm.elements.void.checked = Boolean(room.void);
  roomForm.elements.color.value = room.color ?? "gray";
  showColorSample();
  roomForm.elements.exterior.checked = Boolean(room.exterior);
  for (const input of roomForm.querySelectorAll('input[name="facades"]')) {
    input.checked = (room.facades ?? []).includes(input.value);
  }
  syncExterior();
  document.querySelector("#room-dialog-title").textContent =
    `${index === null ? "Adicionar" : "Editar"} cômodo`;
  renderConnections(room);
  roomDialog.showModal();
}

// Keep links symmetric when a room is added, renamed, or edited.
function saveEditedRoom(event) {
  event.preventDefault();
  const nameField = roomForm.elements.name;
  nameField.setCustomValidity("");
  const name = nameField.value.trim();
  if (roomData.some((room, index) => room.name === name && index !== editingIndex)) {
    nameField.setCustomValidity("Já existe um cômodo com esse nome.");
    nameField.reportValidity();
    return;
  }
  const oldName = editingIndex === null ? null : roomData[editingIndex].name;
  const links = [...roomForm.querySelectorAll('input[name="links"]:checked')].map(input => input.value);
  const facades = [...roomForm.querySelectorAll('input[name="facades"]:checked')].map(input => input.value);
  const room = {
    name,
    links,
    facades,
    exterior: roomForm.elements.exterior.checked || facades.length > 0,
    void: roomForm.elements.void.checked,
    corridor: roomForm.elements.corridor.checked,
    color: roomForm.elements.color.value,
    minArea: Number(roomForm.elements.minArea.value),
    maxArea: Number(roomForm.elements.maxArea.value),
    minSide: Number(roomForm.elements.minSide.value),
  };
  if (editingIndex === null) {
    roomData.push(room);
  } else {
    roomData[editingIndex] = room;
  }
  roomData = roomData.map(item => {
    if (item === room) return item;
    const nextLinks = item.links.filter(link => link !== oldName && link !== name);
    if (links.includes(item.name)) nextLinks.push(name);
    return { ...item, links: nextLinks };
  });
  removedRooms = null;
  undoRemove.hidden = true;
  renderRoomList();
  roomDialog.close();
  message.textContent = "Cômodo salvo. Gere novamente para atualizar as opções.";
}

// Load a saved or example input into the editable list.
function loadInput(input) {
  roomData = input.rooms.map(room => ({
    ...room,
    minSide: room.minSide ?? input.minSide ?? 1.2,
    void: Boolean(room.void),
    exterior: room.exterior ?? !(room.void || room.corridor),
    facades: room.facades ?? [],
    links: room.links ?? [],
  }));
  renderRoomList();
  results.replaceChildren();
  message.textContent = "Entradas carregadas. Você pode editar e gerar opções.";
}

// Persist the editable inputs so a reload never loses work; storage may be off.
const STATE_KEY = "planta-state";
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ rooms: roomData, engine: engineSelect.value }));
  } catch {}
}

// Restore the last session's inputs; false when nothing usable was stored.
function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (!Array.isArray(saved?.rooms)) return false;
    if (engineList.some(engine => engine.id === saved.engine)) {
      engineSelect.value = saved.engine;
      engineSelect.dispatchEvent(new Event("change"));
    }
    loadInput({ rooms: saved.rooms });
    return true;
  } catch {
    return false;
  }
}

// Display the three best options, then the revealed share of the bottom gallery.
function showOptions(options, others = []) {
  bestOptions = options;
  alternatives = others;
  shownAlternatives = Math.min(ALTERNATIVE_BATCH, alternatives.length);
  renderResults();
  message.textContent = options.some(option => option.layout) || alternatives.length
    ? "Opções geradas. Ajuste as entradas se quiser explorar outros arranjos."
    : "Não encontramos opções. Tente relaxar as restrições ou adicionar conexões.";
}

// Render the best options plus the alternatives already requested by the button.
function renderResults() {
  const more = alternatives.length ? `<section class="alternatives" aria-label="Outras opções">
    <h2>Outras opções</h2>
    <p class="meta">O mesmo programa com outras paredes compartilhadas; cada arranjo tem um grafo de contatos diferente.</p>
    ${alternatives.slice(0, shownAlternatives).map(render).join("")}
    ${shownAlternatives < alternatives.length
      ? `<button id="more-options" type="button" class="secondary">Mostrar mais opções (${shownAlternatives} de ${alternatives.length})</button>`
      : ""}
  </section>` : "";
  results.innerHTML = bestOptions.map(render).join("") + more;
}

// The gallery is re-rendered wholesale, so listen on the results container.
results.addEventListener("click", event => {
  if (!event.target.closest("#more-options")) return;
  shownAlternatives = Math.min(shownAlternatives + ALTERNATIVE_BATCH, alternatives.length);
  renderResults();
});

const STATUS_LABELS = {
  optimal: "ótimo comprovado",
  feasible: "melhor encontrado",
  loose: "formato livre",
  infeasible: "impossível",
  unknown: "indeterminado",
  failed: "não encontrado",
};

// Human-readable engine name for the results header.
function engineLabel(id) {
  return engineList.find(engine => engine.id === id)?.label ?? id;
}

function render(option) {
  if (!option.layout) return `<article class="option"><h2>${option.label}</h2><p>Não foi encontrada uma opção nesta busca (${escapeHTML(STATUS_LABELS[option.status] ?? option.status)}).</p></article>`;
  // North is always up, so the plan is never rotated and facade names stay meaningful.
  const bounds = option.bounds ?? {
    minX: Math.min(...option.layout.map(room => room.x)),
    minY: Math.min(...option.layout.map(room => room.y)),
    maxX: Math.max(...option.layout.map(room => room.x + room.w)),
    maxY: Math.max(...option.layout.map(room => room.y + room.h)),
  };
  const layout = option.layout;
  const minX = bounds.minX;
  const minY = bounds.minY;
  const maxX = bounds.maxX;
  const maxY = bounds.maxY;
  const scale = Math.min(700 / (maxX - minX), 420 / (maxY - minY), 18);
  const width = (maxX - minX) * scale;
  const height = (maxY - minY) * scale;
  const planWidth = (maxX - minX) / 10;
  const planHeight = (maxY - minY) / 10;
  const boxArea = planWidth * planHeight;
  const roomArea = layout.reduce((sum, room) => sum + room.w * room.h, 0) / 100;
  const tight = Math.abs(boxArea - roomArea) < 0.01;
  const size = tight
    ? `Dimensões externas: ${planWidth.toFixed(1)} × ${planHeight.toFixed(1)} m · Área total: ${roomArea.toFixed(1)} m² · Perímetro: ${(2 * (planWidth + planHeight)).toFixed(1)} m`
    : `Área útil: ${roomArea.toFixed(1)} m² · Caixa: ${planWidth.toFixed(1)} × ${planHeight.toFixed(1)} m · formato livre`;
  return `<article class="option">
    <h2>${option.label}</h2>
    <p class="meta">${size} · Motor: ${escapeHTML(engineLabel(option.engine))} · ${escapeHTML(STATUS_LABELS[option.status] ?? option.status)}</p>
    <div class="plan" role="img" aria-label="Planta: ${escapeHTML(layout.map(room => room.room).join(", "))}" style="width:${width}px;height:${height}px">
      <span class="compass" aria-hidden="true">N ↑</span>
      ${layout.map(room => `<div class="room color-${escapeHTML(room.color ?? "gray")}${room.void ? " void" : ""}"
        style="left:${(room.x-minX)*scale}px;top:${(room.y-minY)*scale}px;width:${room.w*scale}px;height:${room.h*scale}px">
        <strong>${escapeHTML(room.room)}</strong><span>${(room.w/10).toFixed(1)} × ${(room.h/10).toFixed(1)} m · ${(room.w*room.h/100).toFixed(1)} m²${room.touchesExterior ? " · externa" : ""}</span></div>`).join("")}
    </div>
  </article>`;
}

document.querySelector("#add-room").addEventListener("click", () => openRoomEditor(null));
document.querySelector("#add-corridor").addEventListener("click", () => {
  if (roomData.some(room => room.corridor)) {
    message.textContent = "A planta já tem um corredor.";
    return;
  }
  openRoomEditor(null, true);
});
roomList.addEventListener("click", event => {
  const item = event.target.closest("[data-index]");
  if (item) openRoomEditor(Number(item.dataset.index));
});
roomList.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-index]");
  if (!item) return;
  event.preventDefault();
  openRoomEditor(Number(item.dataset.index));
});
roomList.addEventListener("dragstart", event => {
  const item = event.target.closest("[data-index]");
  if (!item) return;
  dragIndex = Number(item.dataset.index);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(dragIndex));
});
roomList.addEventListener("dragover", event => {
  if (event.target.closest("[data-index]")) event.preventDefault();
});
roomList.addEventListener("drop", event => {
  event.preventDefault();
  const target = event.target.closest("[data-index]");
  if (!target || dragIndex === null) return;
  const [room] = roomData.splice(dragIndex, 1);
  roomData.splice(Number(target.dataset.index), 0, room);
  dragIndex = null;
  renderRoomList();
});
roomList.addEventListener("dragend", () => { dragIndex = null; });
removeRoom.addEventListener("dragover", event => {
  event.preventDefault();
  removeRoom.classList.add("drag-over");
});
removeRoom.addEventListener("dragleave", () => removeRoom.classList.remove("drag-over"));
removeRoom.addEventListener("drop", event => {
  event.preventDefault();
  removeRoom.classList.remove("drag-over");
  if (dragIndex === null) return;
  removedRooms = structuredClone(roomData);
  const [removed] = roomData.splice(dragIndex, 1);
  roomData = roomData.map(room => ({ ...room, links: room.links.filter(link => link !== removed.name) }));
  dragIndex = null;
  renderRoomList();
  undoRemove.hidden = false;
  message.textContent = `${removed.name} removido.`;
});
undoRemove.addEventListener("click", () => {
  if (!removedRooms) return;
  roomData = removedRooms;
  removedRooms = null;
  undoRemove.hidden = true;
  renderRoomList();
  message.textContent = "Remoção desfeita.";
});
roomForm.elements.color.addEventListener("change", showColorSample);
for (const input of roomForm.querySelectorAll('input[name="facades"]')) input.addEventListener("change", syncExterior);
roomForm.addEventListener("submit", saveEditedRoom);
document.querySelector("#cancel-room").addEventListener("click", () => roomDialog.close());
connectionGraph.addEventListener("click", openGraph);
connectionGraph.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openGraph();
});
document.querySelector("#graph-close").addEventListener("click", () => graphDialog.close());
document.querySelector("#planner").addEventListener("submit", async event => {
  event.preventDefault();
  results.replaceChildren();
  setBusy("Calculando opções…");
  try {
    const result = await solve({ rooms: roomData, engine: engineSelect.value });
    if (!result.ok) {
      message.textContent = result.error;
      return;
    }
    showOptions(result.options, result.alternatives ?? []);
  } catch (error) {
    message.textContent = `Não foi possível calcular: ${error.message}`;
  } finally {
    clearBusy();
  }
});

document.querySelector("#save-file").addEventListener("click", () => {
  const input = { rooms: roomData };
  const file = new Blob([JSON.stringify({ format: "planta-helper", version: 3, engine: engineSelect.value, input }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "planta-helper.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

document.querySelector("#open-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const saved = JSON.parse(await file.text());
    if (saved.format !== "planta-helper" || ![1, 2, 3].includes(saved.version) || !saved.input) {
      throw new Error("Formato de arquivo não reconhecido.");
    }
    if (engineList.some(engine => engine.id === saved.engine)) {
      engineSelect.value = saved.engine;
      engineSelect.dispatchEvent(new Event("change"));
    }
    // Only the inputs are restored; solving is left to the "Gerar opções" button.
    loadInput(saved.input);
    const error = validate(roomData);
    if (error) message.textContent = error;
  } catch (error) {
    message.textContent = `Não foi possível abrir o arquivo: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#samples").insertAdjacentHTML("beforeend", samples.map(sample =>
  `<option value="${escapeHTML(sample.id)}">${escapeHTML(sample.title)}</option>`).join(""));
// Loading an example is a one-shot choice, so the select returns to its placeholder.
document.querySelector("#samples").addEventListener("change", event => {
  const sample = samples.find(item => item.id === event.target.value);
  event.target.value = "";
  if (sample) loadInput(sample.input);
});

// Restore the previous session, falling back to the last example on first visit.
if (!restoreState()) loadInput(samples.at(-1).input);
