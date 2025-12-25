const $ = (id) => document.getElementById(id);

const defaultState = () => ({
  sessionId: `demo_${Math.random().toString(16).slice(2,10)}`,
  vertical: "Dentaire",
  patient: { name: "", phone: "" },
  appointments: [],
  tickets: [],
  slots: [],
});

let state = (() => {
  try {
    const raw = localStorage.getItem("frontdesk_demo_state");
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
})();

function save() {
  localStorage.setItem("frontdesk_demo_state", JSON.stringify(state));
}

function addMessage(role, text){
  const wrap = document.createElement("div");
  wrap.className = "msg" + (role === "user" ? " me" : "");
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const r = document.createElement("div");
  r.className = "role";
  r.textContent = role === "user" ? "Vous" : "AI Front Desk";
  const c = document.createElement("div");
  c.className = "content";
  c.textContent = text;
  bubble.appendChild(r);
  bubble.appendChild(c);
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function pillClass(status){
  if (status === "cancelled") return "bad";
  if (status === "rescheduled") return "warn";
  return "good";
}

function renderTable(containerId, rows, kind){
  const container = $(containerId);
  container.innerHTML = "";

  if (!rows || rows.length === 0){
    const empty = document.createElement("div");
    empty.className = "row";
    empty.innerHTML = `<div class="kv"><span class="key">—</span><span class="val">Aucun</span></div>`;
    container.appendChild(empty);
    return;
  }

  for (const row of rows){
    const el = document.createElement("div");
    el.className = "row";

    if (kind === "appointments"){
      el.innerHTML = `
        <div class="kv"><span class="key">ID</span><span class="val">${row.id}</span></div>
        <div class="kv"><span class="key">Patient</span><span class="val">${row.patient_name || "—"}</span></div>
        <div class="kv"><span class="key">Motif</span><span class="val">${row.reason || "—"}</span></div>
        <div class="kv"><span class="key">Date</span><span class="val">${(row.datetime || "").replace("T"," ")}</span></div>
        <div class="kv"><span class="key">Statut</span><span class="val"><span class="pill ${pillClass(row.status)}">${row.status}</span></span></div>
      `;
    } else if (kind === "tickets"){
      el.innerHTML = `
        <div class="kv"><span class="key">ID</span><span class="val">${row.id}</span></div>
        <div class="kv"><span class="key">Sujet</span><span class="val">${row.topic}</span></div>
        <div class="kv"><span class="key">Priorité</span><span class="val"><span class="pill ${row.priority==="high"?"bad":"warn"}">${row.priority}</span></span></div>
        <div class="kv"><span class="key">Patient</span><span class="val">${row.patient_name}</span></div>
      `;
    } else if (kind === "slots"){
      el.innerHTML = `
        <div class="kv"><span class="key">${row.id}</span><span class="val">${(row.datetime || "").replace("T"," ")}</span></div>
        <div class="kv"><span class="key">Label</span><span class="val">${row.label || ""}</span></div>
      `;
    }
    container.appendChild(el);
  }
}

function setSessionBadge(){
  $("sessionBadge").textContent = `Session: ${state.sessionId}`;
}

function rerender(){
  renderTable("appointments", state.appointments, "appointments");
  renderTable("tickets", state.tickets, "tickets");
  renderTable("slots", state.slots, "slots");
  setSessionBadge();
  save();
}

function uid(prefix="A"){
  return `${prefix}${Math.random().toString(16).slice(2,10)}`;
}

function applyActions(actions){
  const applied = [];
  for (const a of (actions || [])){
    if (!a || !a.type) continue;

    if (a.type === "create_appointment"){
      const appt = {
        id: uid("R"),
        patient_name: (a.patient_name || state.patient.name || "").trim(),
        phone: (a.phone || state.patient.phone || "").trim(),
        reason: (a.reason || "Consultation").trim(),
        datetime: (a.datetime || "").trim(),
        site: (a.site || "").trim(),
        status: "confirmed",
        created_at: new Date().toISOString(),
      };
      state.appointments.push(appt);
      if (appt.patient_name) state.patient.name = appt.patient_name;
      if (appt.phone) state.patient.phone = appt.phone;
      applied.push("create_appointment");
      continue;
    }

    if (a.type === "reschedule_appointment"){
      const id = String(a.appointment_id || "").trim();
      const nd = String(a.new_datetime || "").trim();
      const appt = state.appointments.find(x => x.id === id);
      if (appt && nd){
        appt.datetime = nd;
        appt.status = "rescheduled";
        applied.push("reschedule_appointment");
      }
      continue;
    }

    if (a.type === "cancel_appointment"){
      const id = String(a.appointment_id || "").trim();
      const appt = state.appointments.find(x => x.id === id);
      if (appt){
        appt.status = "cancelled";
        applied.push("cancel_appointment");
      }
      continue;
    }

    if (a.type === "create_ticket"){
      const ticket = {
        id: uid("T"),
        topic: String(a.topic || "Demande").trim(),
        priority: String(a.priority || "normal").trim(),
        patient_name: String(a.patient_name || state.patient.name || "Inconnu").trim(),
        phone: String(a.phone || state.patient.phone || "").trim(),
        created_at: new Date().toISOString(),
      };
      state.tickets.push(ticket);
      applied.push("create_ticket");
      continue;
    }
  }
  return applied;
}

async function sendMessage(text){
  addMessage("user", text);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      message: text,
      vertical: state.vertical,
      state: {
        patient: state.patient,
        appointments: state.appointments,
        tickets: state.tickets,
      }
    })
  });

  const data = await res.json();
  if (!res.ok){
    addMessage("assistant", `Erreur: ${data.message || "server_error"}`);
    return;
  }

  addMessage("assistant", data.reply || "");

  state.slots = data.slots || state.slots;

  const applied = applyActions(data.actions || []);
  rerender();

  if (applied.length){
    addMessage("assistant", `🔧 Actions exécutées: ${applied.join(", ")}`);
  }
}

function resetDemo(){
  localStorage.removeItem("frontdesk_demo_state");
  state = defaultState();
  $("messages").innerHTML = "";
  addMessage("assistant", "Bonjour 👋 Je suis l'assistant virtuel. Je peux prendre un RDV, déplacer/annuler, ou répondre aux questions. Que souhaitez-vous ?");
  rerender();
}

$("vertical").value = state.vertical;
$("vertical").addEventListener("change", (e) => {
  state.vertical = e.target.value;
  addMessage("assistant", `✅ Vertical sélectionné: ${state.vertical}. Quel est votre besoin ?`);
  rerender();
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("input");
  const text = (input.value || "").trim();
  if (!text) return;
  input.value = "";
  sendMessage(text);
});

$("reset").addEventListener("click", resetDemo);

setSessionBadge();
addMessage("assistant", "Bonjour 👋 Je suis l'assistant virtuel. Je peux prendre un RDV, déplacer/annuler, ou répondre aux questions. Que souhaitez-vous ?");
rerender();
