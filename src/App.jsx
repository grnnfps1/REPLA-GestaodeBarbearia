import React, { useState, useMemo, useEffect } from "react";
import { supabase } from "./supabaseClient";

// As colunas do banco (em português) viram exatamente os campos que a tela
// já usava, para que o visual continue idêntico.
function mapBarber(row) {
  return {
    id: row.id,
    nome: row.nome,
    foto_url: row.foto_url,
    bio: row.bio || "",
    especialidades: row.especialidades || [],
    instagram: row.instagram || "",
    whatsapp: row.whatsapp || "",
  };
}

function mapService(row) {
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao || "",
    preco: row.preco,
    duracao_min: row.duracao_min,
  };
}

const TODAY_APPTS = [
  { time: "09:30", client: "Bruno Salles", phone: "(21) 98812-4410", barber: "Rafael Moretti", service: "Corte + Barba", status: "confirmado" },
  { time: "10:40", client: "André Lima", phone: "(21) 99640-2231", barber: "Diego Antunes", service: "Corte", status: "confirmado" },
  { time: "11:30", client: "Marcos Vinícius", phone: "(21) 98120-7788", barber: "Rafael Moretti", service: "Barba", status: "pendente" },
  { time: "14:00", client: "Felipe Rocha", phone: "(21) 99903-1120", barber: "Léo Vasques", service: "Corte", status: "confirmado" },
  { time: "15:30", client: "Thiago Nunes", phone: "(21) 98450-9987", barber: "Rafael Moretti", service: "Navalhado", status: "confirmado" },
];

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function nextDays(n) {
  const out = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  return out;
}

function slotsFor() {
  const taken = new Set(["09:30", "11:30", "15:30"]);
  const out = [];
  for (let h = 9; h < 19; h++) {
    for (const m of [0, 30]) {
      const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      out.push({ t, free: !taken.has(t) });
    }
  }
  return out;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap');

.au-root, .au-root * { box-sizing: border-box; margin: 0; padding: 0; }
.au-root {
  --espresso: #171310;
  --espresso-2: #0f0c0a;
  --surface: #221b16;
  --surface-2: #2b221c;
  --gold: #c9a35b;
  --gold-soft: #d8bd86;
  --cream: #ece1cf;
  --taupe: #9a8f80;
  --line: rgba(201,163,91,0.18);
  --line-soft: rgba(236,225,207,0.08);
  font-family: 'Inter', system-ui, sans-serif;
  color: var(--cream);
  background: var(--espresso);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
.au-serif { font-family: 'Fraunces', serif; }

.au-top {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 24px;
  background: rgba(15,12,10,0.82);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line-soft);
}
.au-mark { display: flex; align-items: center; gap: 12px; }
.au-monogram {
  width: 34px; height: 34px; border-radius: 50%;
  border: 1.5px solid var(--gold);
  display: grid; place-items: center;
  color: var(--gold); font-family: 'Fraunces', serif; font-weight: 600; font-size: 16px;
}
.au-mark-name { font-family: 'Fraunces', serif; font-size: 17px; letter-spacing: 0.14em; color: var(--cream); }
.au-switch { display: flex; gap: 4px; background: var(--espresso-2); border: 1px solid var(--line-soft); border-radius: 999px; padding: 4px; }
.au-switch button {
  border: 0; background: transparent; color: var(--taupe); cursor: pointer;
  font-family: inherit; font-size: 12.5px; font-weight: 500; padding: 7px 14px; border-radius: 999px;
  transition: color .2s;
}
.au-switch button.on { background: var(--gold); color: #1a1410; font-weight: 600; }

.au-hero {
  position: relative;
  padding: 92px 24px 80px;
  text-align: center;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% -10%, rgba(201,163,91,0.14), transparent 60%),
    var(--espresso);
  border-bottom: 1px solid var(--line-soft);
}
.au-hero-est { color: var(--gold); font-size: 12px; letter-spacing: 0.42em; margin-bottom: 22px; }
.au-hero h1 { font-family: 'Fraunces', serif; font-weight: 600; font-size: clamp(48px, 12vw, 104px); line-height: 0.92; color: var(--cream); }
.au-hero h1 em { font-style: italic; color: var(--gold-soft); }
.au-hero-tag { margin: 26px auto 0; max-width: 440px; color: var(--taupe); font-size: 16px; line-height: 1.6; }
.au-rule { width: 1px; height: 46px; background: var(--gold); margin: 40px auto 0; opacity: .6; }

.au-btn {
  display: inline-flex; align-items: center; gap: 9px; cursor: pointer;
  font-family: inherit; font-weight: 600; font-size: 14px;
  border-radius: 999px; padding: 15px 30px; border: 0;
  background: var(--gold); color: #1a1410;
  transition: transform .15s, background .2s;
}
.au-btn:hover { background: var(--gold-soft); transform: translateY(-1px); }
.au-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
.au-btn-ghost { background: transparent; color: var(--cream); border: 1px solid var(--line); }
.au-btn-ghost:hover { background: rgba(201,163,91,0.08); border-color: var(--gold); }

.au-sec { max-width: 1080px; margin: 0 auto; padding: 78px 24px; }
.au-sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 40px; gap: 20px; flex-wrap: wrap; }
.au-sec-head h2 { font-family: 'Fraunces', serif; font-weight: 600; font-size: clamp(30px, 5vw, 42px); color: var(--cream); }
.au-sec-head p { color: var(--taupe); font-size: 14.5px; max-width: 340px; line-height: 1.55; }

.au-barbers { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 22px; }
.au-bcard {
  background: linear-gradient(180deg, var(--surface), var(--espresso-2));
  border: 1px solid var(--line-soft); border-radius: 18px; overflow: hidden;
  display: flex; flex-direction: column;
}
.au-bphoto { position: relative; aspect-ratio: 4/5; overflow: hidden; }
.au-bphoto img { width: 100%; height: 100%; object-fit: cover; filter: grayscale(0.15) contrast(1.02); }
.au-bphoto::after { content:''; position:absolute; inset:0; background: linear-gradient(180deg, transparent 55%, rgba(15,12,10,0.92)); }
.au-brole {
  position: absolute; top: 14px; left: 14px; z-index: 2;
  font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--gold); background: rgba(15,12,10,0.7); border: 1px solid var(--line);
  padding: 5px 10px; border-radius: 999px;
}
.au-bbody { padding: 18px 20px 22px; margin-top: -46px; position: relative; z-index: 3; }
.au-bname { font-family: 'Fraunces', serif; font-size: 23px; color: var(--cream); }
.au-bbio { color: var(--taupe); font-size: 13.5px; line-height: 1.55; margin-top: 8px; }
.au-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.au-tag { font-size: 11px; color: var(--gold-soft); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; }
.au-social { display: flex; gap: 10px; margin-top: 18px; }
.au-social a {
  display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
  color: var(--cream); font-size: 12px; font-weight: 500;
  border: 1px solid var(--line-soft); border-radius: 10px; padding: 8px 12px; flex: 1; justify-content: center;
  transition: border-color .2s, color .2s;
}
.au-social a:hover { border-color: var(--gold); color: var(--gold-soft); }
.au-bbook { margin-top: 12px; width: 100%; justify-content: center; }

.au-menu { border-top: 1px solid var(--line-soft); }
.au-srow {
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 18px;
  padding: 22px 6px; border-bottom: 1px solid var(--line-soft);
}
.au-sname { font-family: 'Fraunces', serif; font-size: 22px; color: var(--cream); }
.au-sdesc { color: var(--taupe); font-size: 13.5px; margin-top: 4px; }
.au-smeta { text-align: right; white-space: nowrap; }
.au-sprice { font-family: 'Fraunces', serif; font-size: 24px; color: var(--gold-soft); }
.au-smin { color: var(--taupe); font-size: 12px; margin-top: 2px; }

.au-foot { border-top: 1px solid var(--line-soft); padding: 46px 24px; text-align: center; color: var(--taupe); font-size: 13px; }
.au-foot .au-mark { justify-content: center; margin-bottom: 16px; }

.au-ov { position: fixed; inset: 0; z-index: 60; background: rgba(9,7,5,0.72); backdrop-filter: blur(6px); display: flex; align-items: flex-end; justify-content: center; }
@media (min-width: 720px){ .au-ov { align-items: center; } }
.au-sheet {
  background: var(--espresso); border: 1px solid var(--line); border-radius: 22px 22px 0 0;
  width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto;
}
@media (min-width: 720px){ .au-sheet { border-radius: 22px; } }
.au-sheet-head { position: sticky; top: 0; background: var(--espresso); padding: 20px 24px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; }
.au-step-label { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); }
.au-sheet-head h3 { font-family: 'Fraunces', serif; font-size: 22px; color: var(--cream); margin-top: 4px; }
.au-x { background: transparent; border: 1px solid var(--line-soft); color: var(--cream); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; font-size: 16px; }
.au-x:hover { border-color: var(--gold); }
.au-sheet-body { padding: 22px 24px 28px; }

.au-pick { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: 14px; padding: 14px; margin-bottom: 10px; transition: border-color .2s, background .2s; color: var(--cream); font-family: inherit; }
.au-pick:hover { border-color: var(--gold); background: var(--surface-2); }
.au-pick img { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; }
.au-pick-main { flex: 1; }
.au-pick-t { font-size: 15px; font-weight: 600; }
.au-pick-s { font-size: 12.5px; color: var(--taupe); margin-top: 2px; }
.au-pick-p { font-family: 'Fraunces', serif; color: var(--gold-soft); font-size: 18px; }

.au-dates { display: flex; gap: 9px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 20px; }
.au-date { flex: 0 0 auto; width: 62px; text-align: center; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: 12px; padding: 10px 0; color: var(--cream); font-family: inherit; }
.au-date:hover { border-color: var(--gold); }
.au-date.sel { background: var(--gold); color: #1a1410; border-color: var(--gold); }
.au-date .d1 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .8; }
.au-date .d2 { font-family: 'Fraunces', serif; font-size: 22px; margin-top: 2px; }
.au-date .d3 { font-size: 10.5px; opacity: .7; }

.au-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; }
.au-slot { padding: 11px 0; text-align: center; font-size: 13.5px; cursor: pointer; color: var(--cream); font-family: inherit;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: 10px; transition: border-color .2s; }
.au-slot:hover { border-color: var(--gold); }
.au-slot.sel { background: var(--gold); color: #1a1410; border-color: var(--gold); font-weight: 600; }
.au-slot:disabled { opacity: .32; cursor: not-allowed; text-decoration: line-through; }

.au-field { margin-bottom: 16px; }
.au-field label { display: block; font-size: 12px; color: var(--taupe); margin-bottom: 7px; letter-spacing: .02em; }
.au-field input { width: 100%; background: var(--surface); border: 1px solid var(--line-soft); border-radius: 12px; padding: 14px; color: var(--cream); font-family: inherit; font-size: 15px; }
.au-field input:focus { outline: none; border-color: var(--gold); }

.au-summary { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin-bottom: 20px; }
.au-sumrow { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14px; }
.au-sumrow span:first-child { color: var(--taupe); }
.au-sumrow.total { border-top: 1px solid var(--line-soft); margin-top: 6px; padding-top: 12px; }
.au-sumrow.total span:last-child { font-family: 'Fraunces', serif; font-size: 22px; color: var(--gold-soft); }

.au-done { text-align: center; padding: 20px 0 8px; }
.au-check { width: 66px; height: 66px; border-radius: 50%; border: 2px solid var(--gold); color: var(--gold); display: grid; place-items: center; margin: 0 auto 20px; font-size: 30px; }
.au-done h3 { font-family: 'Fraunces', serif; font-size: 27px; color: var(--cream); margin-bottom: 10px; }
.au-done p { color: var(--taupe); font-size: 14.5px; line-height: 1.6; max-width: 360px; margin: 0 auto; }

.au-login { max-width: 380px; margin: 0 auto; padding: 90px 24px; }
.au-login h2 { font-family: 'Fraunces', serif; font-size: 32px; color: var(--cream); text-align: center; margin-bottom: 6px; }
.au-login p { text-align: center; color: var(--taupe); font-size: 14px; margin-bottom: 32px; }
.au-hint { text-align: center; font-size: 12px; color: var(--taupe); margin-top: 16px; opacity: .8; }

.au-dash { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }
.au-dash-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
.au-dash-head h2 { font-family: 'Fraunces', serif; font-size: 34px; color: var(--cream); }
.au-dash-date { color: var(--gold); font-size: 13px; letter-spacing: .04em; }
.au-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 14px; margin: 26px 0 34px; }
.au-stat { background: linear-gradient(180deg, var(--surface), var(--espresso-2)); border: 1px solid var(--line-soft); border-radius: 16px; padding: 20px; }
.au-stat .n { font-family: 'Fraunces', serif; font-size: 34px; color: var(--gold-soft); line-height: 1; }
.au-stat .l { color: var(--taupe); font-size: 12.5px; margin-top: 8px; }

.au-appts { background: var(--espresso-2); border: 1px solid var(--line-soft); border-radius: 18px; overflow: hidden; }
.au-appt { display: grid; grid-template-columns: 76px 1fr auto; align-items: center; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--line-soft); }
.au-appt:last-child { border-bottom: 0; }
.au-appt-time { font-family: 'Fraunces', serif; font-size: 22px; color: var(--cream); }
.au-appt-client { font-size: 15px; font-weight: 600; color: var(--cream); }
.au-appt-meta { font-size: 12.5px; color: var(--taupe); margin-top: 3px; }
.au-badge { font-size: 11px; padding: 5px 11px; border-radius: 999px; white-space: nowrap; }
.au-badge.ok { color: #a8d5a0; background: rgba(120,190,110,0.12); border: 1px solid rgba(120,190,110,0.25); }
.au-badge.pend { color: var(--gold-soft); background: rgba(201,163,91,0.1); border: 1px solid var(--line); }

.au-note { color: var(--taupe); font-size: 14px; line-height: 1.6; padding: 18px 6px; }
.au-note.err { color: var(--gold-soft); }

@media (max-width: 520px){
  .au-appt { grid-template-columns: 60px 1fr; }
  .au-appt .au-badge { grid-column: 2; justify-self: start; margin-top: 4px; }
}
`;

function Icon({ name }) {
  const p = {
    insta: "M12 2.2c3.2 0 3.6 0 4.85.07 1.17.05 1.8.25 2.23.42.56.22.96.48 1.38.9.42.42.68.82.9 1.38.17.42.37 1.06.42 2.23.06 1.26.07 1.64.07 4.83s0 3.57-.07 4.83c-.05 1.17-.25 1.8-.42 2.23a3.7 3.7 0 0 1-.9 1.38 3.7 3.7 0 0 1-1.38.9c-.42.17-1.06.37-2.23.42-1.26.06-1.64.07-4.85.07s-3.6 0-4.85-.07c-1.17-.05-1.8-.25-2.23-.42a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.17-.42-.37-1.06-.42-2.23C2.21 15.57 2.2 15.19 2.2 12s0-3.57.07-4.83c.05-1.17.25-1.8.42-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.17 1.06-.37 2.23-.42C8.4 2.21 8.8 2.2 12 2.2Zm0 1.8c-3.14 0-3.5 0-4.74.07-.9.04-1.38.19-1.7.31-.43.17-.74.37-1.06.69-.32.32-.52.63-.69 1.06-.12.32-.27.8-.31 1.7C3.13 8.5 3.12 8.86 3.12 12s0 3.5.07 4.74c.04.9.19 1.38.31 1.7.17.43.37.74.69 1.06.32.32.63.52 1.06.69.32.12.8.27 1.7.31 1.24.06 1.6.07 4.74.07s3.5 0 4.74-.07c.9-.04 1.38-.19 1.7-.31.43-.17.74-.37 1.06-.69.32-.32.52-.63.69-1.06.12-.32.27-.8.31-1.7.06-1.24.07-1.6.07-4.74s0-3.5-.07-4.74c-.04-.9-.19-1.38-.31-1.7a2.85 2.85 0 0 0-.69-1.06 2.85 2.85 0 0 0-1.06-.69c-.32-.12-.8-.27-1.7-.31C15.5 4 15.14 4 12 4Zm0 3.06A4.94 4.94 0 1 1 12 17a4.94 4.94 0 0 1 0-9.88Zm0 1.8a3.14 3.14 0 1 0 0 6.28 3.14 3.14 0 0 0 0-6.28Zm5.14-.7a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z",
    wa: "M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2Zm0 1.8a8.2 8.2 0 0 1 6.9 12.6l-.2.3.6 2.3-2.4-.6-.3.2A8.2 8.2 0 1 1 12 3.8Zm-3.1 4c-.15 0-.4.06-.6.3-.2.24-.8.78-.8 1.9s.82 2.2.93 2.35c.12.15 1.6 2.55 3.95 3.48 1.95.77 2.35.62 2.77.58.42-.04 1.36-.55 1.55-1.09.2-.53.2-.99.14-1.08-.06-.1-.2-.15-.44-.27-.24-.12-1.36-.67-1.57-.75-.2-.07-.36-.11-.5.12-.16.24-.58.75-.71.9-.13.15-.26.17-.5.06-.24-.12-1-.37-1.9-1.18-.7-.62-1.18-1.4-1.31-1.63-.13-.24-.01-.37.1-.48.11-.11.24-.28.36-.42.12-.15.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.5-1.26-.7-1.72-.18-.44-.36-.38-.5-.38l-.42-.01Z",
  }[name];
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d={p} /></svg>);
}

export default function App() {
  const [mode, setMode] = useState("client");
  const [booking, setBooking] = useState(null);
  const [authed, setAuthed] = useState(false);

  // Dados vindos do Supabase (antes eram listas fixas no código).
  const [barbers, setBarbers] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // As duas buscas vão juntas para a tela abrir mais rápido.
      const [barbersRes, servicesRes] = await Promise.all([
        supabase.from("barbers").select("*").eq("ativo", true).order("criado_em"),
        supabase.from("services").select("*").eq("ativo", true).order("criado_em"),
      ]);

      if (cancelled) return;

      const err = barbersRes.error || servicesRes.error;
      if (err) {
        setLoadError(err.message);
      } else {
        setBarbers(barbersRes.data.map(mapBarber));
        setServices(servicesRes.data.map(mapService));
      }
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const days = useMemo(() => nextDays(14), []);
  const slots = useMemo(() => slotsFor(), []);

  const startBooking = (barberId = null) =>
    setBooking({ step: barberId ? 1 : 0, barber: barberId, service: null, date: 0, time: null, name: "", phone: "" });

  const b = booking;
  const barberObj = b?.barber ? barbers.find((x) => x.id === b.barber) : null;
  const serviceObj = b?.service ? services.find((x) => x.id === b.service) : null;
  // Quem faz o quê virá da tabela barber_services num próximo passo.
  const availServices = services;

  const steps = ["Profissional", "Serviço", "Data e horário", "Seus dados", "Pronto"];

  return (
    <div className="au-root">
      <style>{CSS}</style>

      <div className="au-top">
        <div className="au-mark">
          <div className="au-monogram">Á</div>
          <div className="au-mark-name">ÁUREA</div>
        </div>
        <div className="au-switch">
          <button className={mode === "client" ? "on" : ""} onClick={() => setMode("client")}>Ver como cliente</button>
          <button className={mode === "manage" ? "on" : ""} onClick={() => setMode("manage")}>Área de gestão</button>
        </div>
      </div>

      {mode === "client" ? (
        <>
          <header className="au-hero">
            <div className="au-hero-est">EST. 2019 · RIO DE JANEIRO</div>
            <h1 className="au-serif">Áurea<br /><em>Barbearia</em></h1>
            <p className="au-hero-tag">Corte, barba e navalha com hora marcada. Reserve com o profissional certo em menos de um minuto.</p>
            <div className="au-rule" />
            <div style={{ marginTop: 34 }}>
              <button className="au-btn" onClick={() => startBooking()}>Agendar horário</button>
            </div>
          </header>

          <section className="au-sec">
            <div className="au-sec-head">
              <h2 className="au-serif">Nossa equipe</h2>
              <p>Cada profissional tem sua assinatura. Escolha por estilo — ou por quem já é seu barbeiro de confiança.</p>
            </div>
            {loading && <div className="au-note">Carregando equipe…</div>}
            {loadError && <div className="au-note err">Não foi possível carregar a equipe: {loadError}</div>}
            <div className="au-barbers">
              {barbers.map((bb) => (
                <article className="au-bcard" key={bb.id}>
                  <div className="au-bphoto">
                    <span className="au-brole">Barbeiro</span>
                    <img src={bb.foto_url} alt={bb.nome} />
                  </div>
                  <div className="au-bbody">
                    <div className="au-bname au-serif">{bb.nome}</div>
                    <p className="au-bbio">{bb.bio}</p>
                    <div className="au-tags">
                      {bb.especialidades.map((s) => <span className="au-tag" key={s}>{s}</span>)}
                    </div>
                    <div className="au-social">
                      <a href={`https://instagram.com/${bb.instagram}`} target="_blank" rel="noreferrer"><Icon name="insta" /> @{bb.instagram}</a>
                      <a href={`https://wa.me/${bb.whatsapp}`} target="_blank" rel="noreferrer"><Icon name="wa" /> WhatsApp</a>
                    </div>
                    <button className="au-btn au-bbook" onClick={() => startBooking(bb.id)}>Agendar com {bb.nome.split(" ")[0]}</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="au-sec" style={{ paddingTop: 0 }}>
            <div className="au-sec-head">
              <h2 className="au-serif">Serviços</h2>
              <p>Preços justos, tempo reservado só para você. Sem fila, sem espera.</p>
            </div>
            {loading && <div className="au-note">Carregando serviços…</div>}
            <div className="au-menu">
              {services.map((s) => (
                <div className="au-srow" key={s.id}>
                  <div>
                    <div className="au-sname au-serif">{s.nome}</div>
                    <div className="au-sdesc">{s.descricao}</div>
                  </div>
                  <div className="au-smeta">
                    <div className="au-sprice au-serif">R$ {s.preco}</div>
                    <div className="au-smin">{s.duracao_min} min</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", marginTop: 40 }}>
              <button className="au-btn" onClick={() => startBooking()}>Reservar meu horário</button>
            </div>
          </section>

          <footer className="au-foot">
            <div className="au-mark">
              <div className="au-monogram">Á</div>
              <div className="au-mark-name">ÁUREA</div>
            </div>
            <div>Rua da Ribeira, 2 · Rio de Janeiro · Ter–Sáb, 9h às 19h</div>
            <div style={{ marginTop: 8, opacity: .6 }}>Protótipo de demonstração</div>
          </footer>
        </>
      ) : (
        !authed ? (
          <div className="au-login">
            <h2 className="au-serif">Área de gestão</h2>
            <p>Entre para ver a agenda do dia.</p>
            <div className="au-field"><label>E-mail</label><input defaultValue="dono@aurea.com" /></div>
            <div className="au-field"><label>Senha</label><input type="password" defaultValue="12345678" /></div>
            <button className="au-btn" style={{ width: "100%", justifyContent: "center" }} onClick={() => setAuthed(true)}>Entrar</button>
            <div className="au-hint">Demo — clique em Entrar para acessar.</div>
          </div>
        ) : (
          <div className="au-dash">
            <div className="au-dash-head">
              <h2 className="au-serif">Agenda de hoje</h2>
              <div className="au-dash-date">{WEEKDAYS[new Date().getDay()].toUpperCase()}, {new Date().getDate()} {MONTHS[new Date().getMonth()].toUpperCase()}</div>
            </div>
            <div className="au-stats">
              <div className="au-stat"><div className="n">{TODAY_APPTS.length}</div><div className="l">Agendamentos hoje</div></div>
              <div className="au-stat"><div className="n">R$ 325</div><div className="l">Faturamento previsto</div></div>
              <div className="au-stat"><div className="n">{TODAY_APPTS.filter(a=>a.status==="pendente").length}</div><div className="l">Aguardando confirmação</div></div>
              <div className="au-stat"><div className="n">{barbers.length}</div><div className="l">Barbeiros ativos</div></div>
            </div>
            <div className="au-appts">
              {TODAY_APPTS.map((a, i) => (
                <div className="au-appt" key={i}>
                  <div className="au-appt-time au-serif">{a.time}</div>
                  <div>
                    <div className="au-appt-client">{a.client}</div>
                    <div className="au-appt-meta">{a.service} · {a.barber} · {a.phone}</div>
                  </div>
                  <span className={`au-badge ${a.status === "confirmado" ? "ok" : "pend"}`}>{a.status}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <button className="au-btn au-btn-ghost" onClick={() => setAuthed(false)}>Sair</button>
            </div>
          </div>
        )
      )}

      {b && (
        <div className="au-ov" onClick={(e) => { if (e.target.classList.contains("au-ov")) setBooking(null); }}>
          <div className="au-sheet">
            <div className="au-sheet-head">
              <div>
                <div className="au-step-label">{b.step < 4 ? `Passo ${b.step + 1} de 4` : "Confirmado"}</div>
                <h3 className="au-serif">{steps[b.step]}</h3>
              </div>
              <button className="au-x" onClick={() => setBooking(null)}>✕</button>
            </div>
            <div className="au-sheet-body">
              {b.step === 0 && barbers.map((bb) => (
                <button className="au-pick" key={bb.id} onClick={() => setBooking({ ...b, barber: bb.id, service: null, step: 1 })}>
                  <img src={bb.foto_url} alt="" />
                  <div className="au-pick-main">
                    <div className="au-pick-t">{bb.nome}</div>
                    <div className="au-pick-s">{bb.especialidades.join(" · ")}</div>
                  </div>
                </button>
              ))}

              {b.step === 1 && availServices.map((s) => (
                <button className="au-pick" key={s.id} onClick={() => setBooking({ ...b, service: s.id, step: 2 })}>
                  <div className="au-pick-main">
                    <div className="au-pick-t">{s.nome}</div>
                    <div className="au-pick-s">{s.duracao_min} min · {s.descricao}</div>
                  </div>
                  <div className="au-pick-p au-serif">R$ {s.preco}</div>
                </button>
              ))}

              {b.step === 2 && (
                <>
                  <div className="au-dates">
                    {days.map((d, i) => (
                      <button key={i} className={`au-date ${b.date === i ? "sel" : ""}`} onClick={() => setBooking({ ...b, date: i, time: null })}>
                        <div className="d1">{WEEKDAYS[d.getDay()]}</div>
                        <div className="d2 au-serif">{d.getDate()}</div>
                        <div className="d3">{MONTHS[d.getMonth()]}</div>
                      </button>
                    ))}
                  </div>
                  <div className="au-slots">
                    {slots.map((s) => (
                      <button key={s.t} className={`au-slot ${b.time === s.t ? "sel" : ""}`} disabled={!s.free} onClick={() => setBooking({ ...b, time: s.t })}>{s.t}</button>
                    ))}
                  </div>
                  <button className="au-btn" style={{ width: "100%", justifyContent: "center", marginTop: 22 }} disabled={!b.time} onClick={() => setBooking({ ...b, step: 3 })}>Continuar</button>
                </>
              )}

              {b.step === 3 && (
                <>
                  <div className="au-summary">
                    <div className="au-sumrow"><span>Profissional</span><span>{barberObj?.nome}</span></div>
                    <div className="au-sumrow"><span>Serviço</span><span>{serviceObj?.nome}</span></div>
                    <div className="au-sumrow"><span>Quando</span><span>{days[b.date].getDate()} {MONTHS[days[b.date].getMonth()]} · {b.time}</span></div>
                    <div className="au-sumrow total"><span>Total</span><span>R$ {serviceObj?.preco}</span></div>
                  </div>
                  <div className="au-field"><label>Seu nome</label><input value={b.name} onChange={(e) => setBooking({ ...b, name: e.target.value })} placeholder="Como devemos te chamar?" /></div>
                  <div className="au-field"><label>Telefone / WhatsApp</label><input value={b.phone} onChange={(e) => setBooking({ ...b, phone: e.target.value })} placeholder="(21) 90000-0000" /></div>
                  <button className="au-btn" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={!b.name || !b.phone} onClick={() => setBooking({ ...b, step: 4 })}>Confirmar agendamento</button>
                </>
              )}

              {b.step === 4 && (
                <div className="au-done">
                  <div className="au-check">✓</div>
                  <h3 className="au-serif">Horário reservado</h3>
                  <p>{b.name.split(" ")[0]}, seu {serviceObj?.nome.toLowerCase()} com {barberObj?.nome.split(" ")[0]} está marcado para <strong style={{ color: "var(--cream)" }}>{days[b.date].getDate()} {MONTHS[days[b.date].getMonth()]} às {b.time}</strong>. Enviaremos um lembrete no WhatsApp.</p>
                  <button className="au-btn" style={{ marginTop: 26 }} onClick={() => setBooking(null)}>Concluir</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}