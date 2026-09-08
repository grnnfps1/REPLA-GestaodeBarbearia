import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import { useInstalacaoPWA } from "./useInstalacaoPWA";
import { FaixaInstalar } from "./InstalarApp";

// Trava o scroll da página de fundo enquanto um overlay está aberto.
// `overflow: hidden` no body sozinho NÃO segura o iOS Safari — lá é preciso
// tirar o body do fluxo com position: fixed. Como isso joga a página para o
// topo, guardamos a posição e devolvemos exatamente onde estava ao fechar.
function useScrollLock(ativo) {
  useEffect(() => {
    if (!ativo) return;

    const body = document.body;
    const posicaoY = window.scrollY;
    const anterior = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = "fixed";
    body.style.top = `-${posicaoY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";

    return () => {
      body.style.position = anterior.position;
      body.style.top = anterior.top;
      body.style.left = anterior.left;
      body.style.right = anterior.right;
      body.style.width = anterior.width;
      body.style.overflow = anterior.overflow;
      // Volta para onde o dedo tinha parado, sem animação.
      window.scrollTo(0, posicaoY);
    };
  }, [ativo]);
}

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

// Soma em reais. Só mostra centavos quando existem: "R$ 90", não "R$ 90,00"
// — e nunca "R$ 90,5", que é o que o toLocaleString cru devolveria.
function precoBR(valor) {
  return valor.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(valor) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// Valor cheio para a área de gestão, sempre com centavos: "R$ 91,00". No app
// do cliente usamos precoBR, que omite o ",00" de propósito — lá o preço é
// uma etiqueta de cardápio, aqui é dinheiro sendo conferido.
function moedaBR(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// A agenda lê os serviços pela tabela de ligação, então cada agendamento vem
// com uma LISTA. Estas duas funções são o único ponto do código que precisa
// conhecer esse formato.
function nomesDosServicos(appt) {
  return (appt.services ?? []).map((s) => s.nome).join(" + ");
}

// Hora em que o atendimento termina, "HH:MM" no fuso fixo da barbearia.
// Espelha a função fim_do_atendimento do banco: início + duração em minutos.
//
// Devolve null quando não dá para saber. duracao_min é NOT NULL desde a
// Parte 3.1, então isto é cinto de segurança — mas note que aqui o certo é
// OMITIR, e não chutar 30 min como o cálculo de horários faz: lá um chute a
// menos liberaria horário ocupado, aqui um chute errado faria o dono planejar
// o dia em cima de um fim que não é verdade.
function fimHoraBR(appt) {
  const minutos = Number(appt.duracao_min);
  if (!Number.isFinite(minutos) || minutos <= 0) return null;

  // O !appt.data_hora não é redundante com o isNaN abaixo: new Date(null)
  // não dá data inválida, dá a época de 1970 — e o card exibiria um fim
  // inventado em vez de omitir.
  if (!appt.data_hora) return null;

  const inicio = new Date(appt.data_hora);
  // Data inválida daria NaN e faria o toISOString abaixo lançar, derrubando
  // a agenda inteira por causa de uma linha ruim.
  if (Number.isNaN(inicio.getTime())) return null;

  return formatHoraBR(new Date(inicio.getTime() + minutos * 60000).toISOString());
}

// Number() protege caso o preço venha como texto do banco.
function totalDoAppt(appt) {
  return (appt.services ?? []).reduce((soma, s) => soma + Number(s.preco ?? 0), 0);
}

// Os dois jeitos de o banco dizer "esse horário já é de outra pessoa":
//
//   23P01  exclusion_violation — a trava de sobreposição, que compara
//          intervalos. É o caso normal desde a Parte 3.1.
//   23505  unique_violation — a constraint antiga (barber_id, data_hora),
//          que só olhava o instante de início. Mantido porque ela pode
//          ainda existir no banco, e porque a chave de appointment_services
//          usa o mesmo código.
const CODIGOS_HORARIO_OCUPADO = ["23P01", "23505"];

// Vindo de supabase.rpc, o código do Postgres chega direto em error.code —
// não vem aninhado. Ainda assim varremos message e details: é mais barato
// do que mostrar "erro inesperado" justamente na falha mais comum daqui.
function horarioJaOcupado(error) {
  if (!error) return false;
  if (CODIGOS_HORARIO_OCUPADO.includes(error.code)) return true;

  const texto = [error.code, error.message, error.details, error.hint]
    .filter(Boolean).join(" ");
  return CODIGOS_HORARIO_OCUPADO.some((c) => texto.includes(c))
    || texto.includes("appointments_sem_sobreposicao");
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

function mapPortfolio(row) {
  return {
    id: row.id,
    path: row.path,
    url: row.url,
  };
}

// Nome do bucket público criado no painel do Supabase (Storage → New bucket).
const BUCKET_PORTFOLIO = "portfolio";

// Reduz a foto ANTES de subir: no máximo 1600px no maior lado, JPEG de
// qualidade 0.82. Uma foto de celular de ~4 MB costuma virar ~250 KB — a
// galeria abre rápido no 4G e o plano gratuito de storage dura muito mais.
const MAX_LADO_PX = 1600;
// Trave de segurança para o arquivo ORIGINAL: acima disso nem tentamos abrir
// a imagem, para não travar o celular do dono.
const MAX_BYTES_ORIGINAL = 25 * 1024 * 1024;

function formatarMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function comprimirImagem(arquivo) {
  try {
    const bitmap = await createImageBitmap(arquivo);
    const escala = Math.min(1, MAX_LADO_PX / Math.max(bitmap.width, bitmap.height));
    const largura = Math.round(bitmap.width * escala);
    const altura = Math.round(bitmap.height * escala);

    const canvas = document.createElement("canvas");
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext("2d");
    // JPEG não tem transparência: sem este fundo, um PNG transparente
    // sairia com manchas pretas.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, largura, altura);
    ctx.drawImage(bitmap, 0, 0, largura, altura);
    bitmap.close?.();

    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    // Se o "comprimido" ficou maior que o original (acontece com imagens
    // pequenas), o original é a melhor escolha.
    if (blob && blob.size < arquivo.size) return { blob, ext: "jpg" };
  } catch {
    // Navegador sem createImageBitmap/canvas: sobe o arquivo original.
  }

  const ext = (arquivo.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
  return { blob: arquivo, ext };
}


const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

// Junta a data escolhida com o horário escolhido num timestamp com fuso
// explícito de Brasília (-03:00). Fixamos o fuso da barbearia em vez de usar
// o do celular do cliente: se alguém agendar viajando, o horário continua
// sendo o da loja. O Brasil não usa horário de verão desde 2019, então -03:00
// não muda ao longo do ano.
function toTimestampBR(date, time) {
  const ano = date.getFullYear();
  const mes = String(date.getMonth() + 1).padStart(2, "0");
  const dia = String(date.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}T${time}:00-03:00`;
}

// O banco devolve o instante em UTC. Estas funções trazem para o horário da
// barbearia usando o MESMO deslocamento fixo do toTimestampBR, para que gravar
// e ler nunca discordem.
const OFFSET_BR_MS = 3 * 60 * 60 * 1000;

function paraBrasilia(iso) {
  return new Date(new Date(iso).getTime() - OFFSET_BR_MS);
}

function formatHoraBR(iso) {
  const b = paraBrasilia(iso);
  return `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
}

function chaveDiaBR(iso) {
  const b = paraBrasilia(iso);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, "0")}-${String(b.getUTCDate()).padStart(2, "0")}`;
}

function formatDiaCurtoBR(iso) {
  const b = paraBrasilia(iso);
  const anoAtual = paraBrasilia(new Date().toISOString()).getUTCFullYear();
  const ano = b.getUTCFullYear();
  // Só mostra o ano quando não é o atual, para o histórico antigo não confundir.
  return `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}${ano !== anoAtual ? ` ${ano}` : ""}`;
}

// Deixa só os números: "(21) 99742-6418" e "21997426418" viram a mesma coisa,
// então a busca funciona com ou sem formatação.
function soDigitos(texto) {
  return (texto || "").replace(/\D/g, "");
}

// Formata como telefone brasileiro enquanto o cliente digita. Como o valor é
// sempre reconstruído a partir dos dígitos, letras simplesmente não entram —
// nem digitadas, nem coladas.
function mascaraTelefone(valor) {
  const d = soDigitos(valor).slice(0, 11); // DDD + 9 dígitos no máximo
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  // 10 dígitos = fixo (4+4); 11 = celular (5+4).
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// DDD + 8 dígitos é o menor telefone válido no Brasil.
function telefoneValido(valor) {
  return soDigitos(valor).length >= 10;
}

// Soma um dia a uma chave YYYY-MM-DD. Usa Date.UTC só para normalizar a
// virada de mês e de ano; é função pura da chave recebida.
function chaveDiaSeguinte(chave) {
  const [ano, mes, dia] = chave.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia + 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Meia-noite de hoje na barbearia, independente do fuso de quem abre a tela.
function inicioDoDiaBR() {
  return `${chaveDiaBR(new Date().toISOString())}T00:00:00-03:00`;
}

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

/* ══════════════════════════════════════════════════════════════════════
   CONFIGURAÇÃO DA BARBEARIA
   Hoje vale para a barbearia única do MVP. Quando o sistema atender mais
   de uma, isto sai daqui e vira configuração por barbearia no banco
   (a tabela working_hours prevista no CLAUDE.md).
   ══════════════════════════════════════════════════════════════════════ */

// Jornada por dia da semana. O índice é o dia (0 = domingo ... 6 = sábado).
// null = fechado.
const HORARIO_FUNCIONAMENTO = [
  null,                               // domingo — fechado
  null,                               // segunda — fechado
  { inicio: "09:00", fim: "19:00" },  // terça
  { inicio: "09:00", fim: "19:00" },  // quarta
  { inicio: "09:00", fim: "19:00" },  // quinta
  { inicio: "09:00", fim: "19:00" },  // sexta
  { inicio: "09:00", fim: "19:00" },  // sábado
];

// De quantos em quantos minutos os horários são oferecidos.
const PASSO_MINUTOS = 30;

function horaParaMinutos(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

function minutosParaHora(minutos) {
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

// Todos os horários que a barbearia oferece nesse dia, sem considerar
// ocupação. O último cabe inteiro antes do fechamento: fim 19:00 com passo
// de 30 min gera até 18:30.
function horariosDoDia(date) {
  const jornada = HORARIO_FUNCIONAMENTO[date.getDay()];
  if (!jornada) return [];

  const out = [];
  const fim = horaParaMinutos(jornada.fim);
  for (let m = horaParaMinutos(jornada.inicio); m < fim; m += PASSO_MINUTOS) {
    out.push(minutosParaHora(m));
  }
  return out;
}

// Minuto em que a barbearia fecha nesse dia (null se estiver fechada). O
// calculo de horarios precisa disso para saber se o combo cabe INTEIRO antes
// do fechamento — horariosDoDia sozinho so garante que o INICIO cabe.
function fechamentoDoDia(date) {
  const jornada = HORARIO_FUNCIONAMENTO[date.getDay()];
  return jornada ? horaParaMinutos(jornada.fim) : null;
}

function estaFechado(date) {
  return HORARIO_FUNCIONAMENTO[date.getDay()] === null;
}

// Minutos desde a meia-noite, agora, no horário da barbearia.
function minutosAgoraBR() {
  const b = paraBrasilia(new Date().toISOString());
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

// Chave YYYY-MM-DD de uma data do calendário (a que o cliente vê e toca).
function chaveDiaLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  /* Safe areas do iOS: afastam o conteúdo da câmera/ilha quando o app roda
     instalado em tela cheia. Onde não há entalhe, env() vale 0 e o padding
     fica exatamente o de antes. */
  padding: calc(14px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right)) 14px calc(24px + env(safe-area-inset-left));
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

/* Mural de fotos. Duas colunas no celular, e quantas couberem daí para
   cima — sem media query, o próprio auto-fill se encarrega. */
.au-gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
@media (min-width: 720px){ .au-gal { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; } }
.au-gal-item {
  position: relative; aspect-ratio: 1/1; overflow: hidden;
  border-radius: 14px; border: 1px solid var(--line-soft);
  background: var(--surface);
}
.au-gal-item img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s ease; }
.au-gal-item:hover img { transform: scale(1.04); }
.au-gal-item:hover { border-color: var(--gold); }

/* Botão de apagar: sempre visível (não depende de hover, que não existe
   no celular) e com 36px de alvo para o dedo. */
.au-gal-del {
  position: absolute; top: 8px; right: 8px;
  width: 36px; height: 36px; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  background: rgba(15,12,10,0.8); border: 1px solid var(--line);
  color: var(--cream); font-size: 14px; line-height: 1; font-family: inherit;
  backdrop-filter: blur(4px);
}
.au-gal-del:hover { border-color: var(--gold); color: var(--gold-soft); }
.au-gal-del:disabled { opacity: .5; cursor: not-allowed; }

.au-foot {
  border-top: 1px solid var(--line-soft); text-align: center; color: var(--taupe); font-size: 13px;
  /* A base ganha o espaço da barrinha de gestos do iPhone. */
  padding: 46px calc(24px + env(safe-area-inset-right)) calc(46px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
}
.au-foot .au-mark { justify-content: center; margin-bottom: 16px; }

/* ── Faixa de instalação do PWA ────────────────────────────────────── */
.au-install {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
  display: flex; align-items: center; gap: 11px;
  background: rgba(15,12,10,0.96);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--line);
  padding: 10px calc(12px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
}
.au-install-mark {
  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
  border: 1.5px solid var(--gold); display: grid; place-items: center;
  color: var(--gold); font-family: 'Fraunces', serif; font-weight: 600; font-size: 14px;
}
/* min-width: 0 é o que permite o texto quebrar em vez de estourar o flex. */
.au-install-txt { flex: 1 1 auto; min-width: 0; }
.au-install-t { font-size: 13px; font-weight: 600; color: var(--cream); line-height: 1.3; }
.au-install-s { font-size: 11.5px; color: var(--taupe); line-height: 1.45; margin-top: 3px; }
.au-install-btn { flex: 0 0 auto; padding: 11px 18px; font-size: 13px; }
.au-install-x {
  flex: 0 0 auto; width: 38px; height: 38px; border-radius: 50%;
  background: transparent; border: 1px solid var(--line-soft); color: var(--cream);
  cursor: pointer; font-size: 14px; display: grid; place-items: center; font-family: inherit;
}
.au-install-x:hover { border-color: var(--gold); }
/* Em tela bem estreita o monograma sai para o texto respirar. */
@media (max-width: 380px) {
  .au-install-mark { display: none; }
  .au-install-btn { padding: 11px 14px; }
}

/* padding-top impede a folha de encostar na câmera quando o conteúdo é alto. */
.au-ov { position: fixed; inset: 0; z-index: 60; background: rgba(9,7,5,0.72); backdrop-filter: blur(6px); display: flex; align-items: flex-end; justify-content: center; padding-top: env(safe-area-inset-top); }
@media (min-width: 720px){ .au-ov { align-items: center; } }
.au-sheet {
  background: var(--espresso); border: 1px solid var(--line); border-radius: 22px 22px 0 0;
  width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto;
  /* Impede que o scroll "vaze" para o fundo ao chegar no fim da folha. */
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
@media (min-width: 720px){ .au-sheet { border-radius: 22px; } }
.au-sheet-head { position: sticky; top: 0; background: var(--espresso); padding: 20px 24px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; }
.au-step-label { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); }
.au-sheet-head h3 { font-family: 'Fraunces', serif; font-size: 22px; color: var(--cream); margin-top: 4px; }
.au-x { background: transparent; border: 1px solid var(--line-soft); color: var(--cream); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; font-size: 16px; }
.au-x:hover { border-color: var(--gold); }
/* A folha é colada na base no celular: o último botão precisa ficar acima da
   barrinha de gestos. */
.au-sheet-body { padding: 22px 24px calc(28px + env(safe-area-inset-bottom)); }

.au-alert {
  background: rgba(201,163,91,0.08); border: 1px solid var(--line); border-radius: 12px;
  padding: 13px 15px; margin-bottom: 16px;
  color: var(--gold-soft); font-size: 13.5px; line-height: 1.5;
}

.au-pick { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: 14px; padding: 14px; margin-bottom: 10px; transition: border-color .2s, background .2s; color: var(--cream); font-family: inherit; }
.au-pick:hover { border-color: var(--gold); background: var(--surface-2); }
.au-pick img { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; }
.au-pick-main { flex: 1; }
.au-pick-t { font-size: 15px; font-weight: 600; }
.au-pick-s { font-size: 12.5px; color: var(--taupe); margin-top: 2px; }
.au-pick-p { font-family: 'Fraunces', serif; color: var(--gold-soft); font-size: 18px; }
.au-pick.sel { border-color: var(--gold); background: var(--surface-2); }

/* Caixa de marcação da escolha múltipla de serviços. O ✓ mora sempre no
   HTML e só ganha cor quando marcado — assim a caixa não muda de tamanho
   e a lista não "pula" a cada toque. */
.au-pick-cb {
  flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px;
  border: 1.5px solid var(--line); display: grid; place-items: center;
  font-size: 13px; line-height: 1; color: transparent;
  transition: background .2s, border-color .2s, color .2s;
}
.au-pick.sel .au-pick-cb { background: var(--gold); border-color: var(--gold); color: #1a1410; }

.au-hint { color: var(--taupe); font-size: 13px; line-height: 1.55; margin: -2px 2px 14px; }

/* Barra de total: gruda no rodapé da folha (que é quem rola) para o preço e
   o botão ficarem sempre à mão no celular, com a lista rolando por baixo.
   As margens negativas cancelam o padding da folha para ela encostar nas
   bordas; a de baixo devolve o respiro da safe-area do iPhone. */
.au-pickbar {
  position: sticky; bottom: 0; z-index: 2;
  margin: 18px -24px calc(-28px - env(safe-area-inset-bottom));
  padding: 14px 24px calc(16px + env(safe-area-inset-bottom));
  background: var(--espresso); border-top: 1px solid var(--line-soft);
}
.au-pickbar-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.au-pickbar-l { font-size: 12.5px; color: var(--taupe); min-width: 0; }
.au-pickbar-p { font-family: 'Fraunces', serif; font-size: 22px; color: var(--gold-soft); white-space: nowrap; }

.au-dates { display: flex; gap: 9px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 20px; }
.au-date { flex: 0 0 auto; width: 62px; text-align: center; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: 12px; padding: 10px 0; color: var(--cream); font-family: inherit; }
.au-date:hover { border-color: var(--gold); }
.au-date.sel { background: var(--gold); color: #1a1410; border-color: var(--gold); }
.au-date .d1 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .8; }
.au-date .d2 { font-family: 'Fraunces', serif; font-size: 22px; margin-top: 2px; }
.au-date .d3 { font-size: 10.5px; opacity: .7; }

/* Altura reservada de ~3 linhas: impede o botão Continuar de pular para
   cima enquanto os horários carregam. */
.au-slots-area { min-height: 138px; }
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
.au-sumrow { display: flex; justify-content: space-between; gap: 14px; padding: 7px 0; font-size: 14px; }
/* min-width: 0 deixa nome de serviço comprido quebrar em vez de empurrar o
   preço para fora da tela no celular. */
.au-sumrow span:first-child { color: var(--taupe); min-width: 0; }
.au-sumrow span:last-child { text-align: right; }
/* Lista de serviços do resumo: nome em destaque, preço discreto — o valor
   que importa ali é o Total, lá embaixo. */
.au-sumsvcs { border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); margin: 6px 0; padding: 4px 0; }
.au-sumrow.svc span:first-child { color: var(--cream); }
.au-sumrow.svc span:last-child { color: var(--taupe); white-space: nowrap; }
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
/* Abas da área de gestão (Agenda / Trabalhos). */
.au-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line-soft); margin: 20px 0 8px; }
.au-tab {
  cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 500;
  background: transparent; border: 0; color: var(--taupe);
  padding: 12px 16px; min-height: 44px;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color .2s, border-color .2s;
}
.au-tab:hover { color: var(--cream); }
.au-tab.on { color: var(--gold-soft); border-bottom-color: var(--gold); font-weight: 600; }

/* Área de upload: o label inteiro é o botão, então o alvo de toque é
   enorme no celular. O input de arquivo fica escondido dentro dele. */
.au-upload {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 6px; cursor: pointer; margin: 22px 0 24px;
  padding: 28px 20px; border-radius: 18px;
  border: 1px dashed var(--line); background: rgba(201,163,91,0.04);
  transition: border-color .2s, background .2s;
}
.au-upload:hover { border-color: var(--gold); background: rgba(201,163,91,0.08); }
.au-upload:has(input:disabled) { cursor: progress; opacity: .75; }
.au-upload input { display: none; }
.au-upload-icon { font-size: 26px; color: var(--gold); line-height: 1; }
.au-upload-t { font-size: 15px; font-weight: 600; color: var(--cream); }
.au-upload-s { font-size: 12.5px; color: var(--taupe); line-height: 1.5; max-width: 380px; }

.au-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 14px; margin: 26px 0 34px; }
.au-stat { background: linear-gradient(180deg, var(--surface), var(--espresso-2)); border: 1px solid var(--line-soft); border-radius: 16px; padding: 20px; }
.au-stat .n { font-family: 'Fraunces', serif; font-size: 34px; color: var(--gold-soft); line-height: 1; }
.au-stat .l { color: var(--taupe); font-size: 12.5px; margin-top: 8px; }

/* Tira de filtros por barbeiro. Rola na horizontal quando não couber,
   para não quebrar o layout em tela estreita. */
.au-chips {
  display: flex; gap: 8px; overflow-x: auto;
  padding-bottom: 4px; margin-bottom: 14px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.au-chips::-webkit-scrollbar { display: none; }
.au-chip {
  flex: 0 0 auto; cursor: pointer; font-family: inherit;
  font-size: 13px; font-weight: 500; white-space: nowrap;
  /* 42px de altura: confortável para o dedo no celular. */
  padding: 11px 16px; min-height: 42px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line-soft); color: var(--taupe);
  transition: border-color .2s, color .2s;
}
.au-chip:hover { border-color: var(--gold); color: var(--cream); }
.au-chip.on { background: var(--gold); border-color: var(--gold); color: #1a1410; font-weight: 600; }

/* Seletor de data nativo, vestido de pastilha. 16px evita o zoom
   automático do iOS ao focar o campo. */
.au-chip-date {
  flex: 0 0 auto; cursor: pointer; font-family: inherit; font-size: 16px;
  padding: 9px 14px; min-height: 42px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line-soft); color: var(--taupe);
}
.au-chip-date.on { border-color: var(--gold); color: var(--gold-soft); }
.au-chip-date::-webkit-calendar-picker-indicator { filter: invert(0.7) sepia(1) saturate(3) hue-rotate(5deg); cursor: pointer; }

.au-search { position: relative; margin-bottom: 16px; }
.au-search input {
  width: 100%; background: var(--surface); border: 1px solid var(--line-soft);
  border-radius: 12px; padding: 14px 50px 14px 16px; color: var(--cream);
  font-family: inherit;
  /* 16px é proposital: abaixo disso o iOS dá zoom sozinho ao focar o campo. */
  font-size: 16px;
}
.au-search input:focus { outline: none; border-color: var(--gold); }
.au-search input::placeholder { color: var(--taupe); }
.au-search-clear {
  position: absolute; right: 9px; top: 50%; transform: translateY(-50%);
  width: 34px; height: 34px; border-radius: 50%;
  background: transparent; border: 1px solid var(--line-soft); color: var(--cream);
  cursor: pointer; font-size: 14px; line-height: 1;
  display: grid; place-items: center;
}
.au-search-clear:hover { border-color: var(--gold); color: var(--gold-soft); }

.au-appts { background: var(--espresso-2); border: 1px solid var(--line-soft); border-radius: 18px; overflow: hidden; }
.au-appt { display: grid; grid-template-columns: 76px 1fr auto; align-items: center; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--line-soft); }
.au-appt:last-child { border-bottom: 0; }
.au-appt-time { font-family: 'Fraunces', serif; font-size: 22px; color: var(--cream); }
/* Valor do atendimento, logo abaixo do horário. Mora na coluna de 76px que
   já existe, então não disputa largura com o texto do meio nem com o selo de
   status — é o que manteria o card inteiro no lugar em tela estreita. */
/* Fim do atendimento, discreto sob o horário de início. "até 11:10" a 11.5px
   ocupa ~52px, dentro dos 76px da coluna — nada de largura é tirado do texto
   do meio nem do selo de status. */
.au-appt-fim { font-size: 11.5px; color: var(--taupe); margin-top: 1px; white-space: nowrap; }
.au-appt-valor { font-size: 12px; color: var(--gold-soft); margin-top: 2px; white-space: nowrap; }
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
  // Sessão real do Supabase Auth. null = deslogado.
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState(null);

  // Dados vindos do Supabase (antes eram listas fixas no código).
  const [barbers, setBarbers] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Mural de fotos: leitura é pública, então carrega junto com o resto da home.
  const [portfolio, setPortfolio] = useState([]);
  // Área de gestão: aba atual ("agenda" ou "trabalhos") e estado do upload.
  const [aba, setAba] = useState("agenda");
  const [enviando, setEnviando] = useState(null);
  const [portfolioError, setPortfolioError] = useState(null);
  const [apagandoId, setApagandoId] = useState(null);
  const inputFotosRef = useRef(null);

  // Gravação do agendamento: saving trava o botão, bookingError mostra o aviso.
  const [saving, setSaving] = useState(false);
  const [bookingError, setBookingError] = useState(null);

  // Agenda real da área de gestão (só carrega para quem está logado).
  const [appts, setAppts] = useState([]);
  const [apptsLoading, setApptsLoading] = useState(true);
  const [apptsError, setApptsError] = useState(null);

  // Busca por telefone. O histórico completo (incluindo passados) só é baixado
  // na primeira vez que o dono busca algo — null = ainda não carregado.
  const [busca, setBusca] = useState("");
  // "todos" ou o id de um barbeiro.
  const [filtroBarbeiro, setFiltroBarbeiro] = useState("todos");
  // "proximos" (hoje em diante) ou uma data YYYY-MM-DD.
  const [filtroData, setFiltroData] = useState("proximos");

  // Derivações dos filtros. Ficam aqui em cima porque os efeitos abaixo
  // dependem delas.
  const hojeBR = chaveDiaBR(new Date().toISOString());
  const amanhaBR = chaveDiaSeguinte(hojeBR);
  const buscaDigitos = soDigitos(busca);
  const buscando = busca.trim() !== "";
  const filtroDataAtiva = filtroData !== "proximos";
  // `appts` só tem de hoje em diante. Para um dia passado a fonte precisa ser
  // o histórico completo — o mesmo que a busca por telefone já usa.
  const filtroDataPassada = filtroDataAtiva && filtroData < hojeBR;
  const precisaHistorico = buscando || filtroDataPassada;
  const [historico, setHistorico] = useState(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState(null);

  // Sessão: lê a que já existe (o Supabase guarda no navegador) e depois
  // fica ouvindo login/logout — inclusive os feitos em outra aba.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evento, novaSessao) => {
      setSession(novaSessao);
      setCheckingSession(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // Só o id do usuário como dependência: a sessão vira um objeto novo a cada
  // renovação de token, e isso refaria a busca sem necessidade.
  const userId = session?.user?.id ?? null;

  // Guarda o instante da última busca, para dois eventos quase simultâneos
  // (visibilitychange + focus) não dispararem duas consultas.
  const ultimaCargaRef = useRef(0);

  // "Carregando" só existe até a primeira carga terminar: o estado começa em
  // true e nunca volta a true. Assim as atualizações em segundo plano trocam
  // os dados sem a lista piscar embaixo do dono enquanto ele lê.
  const loadAppts = useCallback(async () => {
    if (!userId) return;

    ultimaCargaRef.current = Date.now();

    // O JOIN traz o nome do barbeiro e nome+preço de TODOS os serviços numa
    // só ida. O "!appointment_services" é obrigatório: existem dois caminhos
    // de appointments até services (a coluna antiga service_id e a tabela de
    // ligação), e sem dizer qual usar o Supabase recusa a consulta.
    const { data, error } = await supabase
      .from("appointments")
      .select("*, barbers(nome), services!appointment_services(nome, preco)")
      .gte("data_hora", inicioDoDiaBR())
      .order("data_hora", { ascending: true });

    if (error) setApptsError(error.message);
    else {
      setAppts(data);
      setApptsError(null);
    }
    setApptsLoading(false);
  }, [userId]);

  // Carga inicial ao entrar. Envolvida numa função async de propósito: deixa
  // explícito que nenhum estado muda de forma síncrona dentro do efeito.
  useEffect(() => {
    if (!userId) return;
    void (async () => { await loadAppts(); })();
  }, [userId, loadAppts]);

  // Mantém a agenda fresca sem F5: quando a aba volta a ficar visível ou ganha
  // foco, e a cada 45s enquanto estiver visível.
  useEffect(() => {
    if (!userId) return;

    const atualizar = () => {
      if (document.visibilityState !== "visible") return;
      // Nunca duas consultas em menos de 5 segundos.
      if (Date.now() - ultimaCargaRef.current < 5000) return;
      loadAppts();
    };

    document.addEventListener("visibilitychange", atualizar);
    window.addEventListener("focus", atualizar);
    const intervalo = setInterval(atualizar, 45000);

    return () => {
      document.removeEventListener("visibilitychange", atualizar);
      window.removeEventListener("focus", atualizar);
      clearInterval(intervalo);
    };
  }, [userId, loadAppts]);

  // Baixa o histórico completo uma única vez por sessão, quando algo precisa
  // enxergar o passado: uma busca por telefone ou um filtro de data anterior
  // a hoje. Sem isso, nada disso roda.
  useEffect(() => {
    if (!userId || !precisaHistorico || historico !== null) return;

    let cancelled = false;

    async function loadHistorico() {
      setHistLoading(true);
      setHistError(null);

      const { data, error } = await supabase
        .from("appointments")
        .select("*, barbers(nome), services!appointment_services(nome, preco)")
        .order("data_hora", { ascending: false })
        .limit(2000);

      if (cancelled) return;

      if (error) setHistError(error.message);
      else setHistorico(data);
      setHistLoading(false);
    }

    loadHistorico();
    return () => { cancelled = true; };
  }, [userId, precisaHistorico, historico]);

  async function handleLogin() {
    if (signingIn) return;
    setSigningIn(true);
    setAuthError(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: senha,
    });

    setSigningIn(false);

    if (error) {
      // Mensagem única de propósito: não revelamos se o e-mail existe ou não.
      setAuthError("E-mail ou senha inválidos.");
      return;
    }
    // Sucesso: o onAuthStateChange acima atualiza a sessão e a tela troca sozinha.
    setSenha("");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setEmail("");
    setSenha("");
    setAuthError(null);
    // Não deixa nome e telefone de cliente na memória depois que o dono sai.
    setAppts([]);
    setHistorico(null);
    setBusca("");
    setFiltroBarbeiro("todos");
    setFiltroData("proximos");
    setAba("agenda");
    setPortfolioError(null);
    // Volta ao estado de "primeira carga" para o próximo login.
    setApptsLoading(true);
  }

  // Recarrega o mural. Fica separado porque também roda depois de cada
  // upload e de cada exclusão na área de gestão.
  const loadPortfolio = useCallback(async () => {
    const { data, error } = await supabase
      .from("portfolio_items")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      // Na home isso é silencioso: sem fotos, a seção simplesmente não aparece.
      setPortfolioError(error.message);
      return;
    }
    setPortfolio(data.map(mapPortfolio));
    setPortfolioError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // As três buscas vão juntas para a tela abrir mais rápido.
      const [barbersRes, servicesRes] = await Promise.all([
        supabase.from("barbers").select("*").eq("ativo", true).order("criado_em"),
        supabase.from("services").select("*").eq("ativo", true).order("criado_em"),
        loadPortfolio(),
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
  }, [loadPortfolio]);

  // Sobe uma ou várias fotos: comprime, manda para o bucket e registra a
  // linha no banco. Uma foto que falha não impede as outras de subirem.
  async function handleUploadFotos(lista) {
    const arquivos = Array.from(lista || []).filter((f) => f.type.startsWith("image/"));
    if (arquivos.length === 0) return;

    setPortfolioError(null);
    const falhas = [];

    for (let i = 0; i < arquivos.length; i++) {
      const arquivo = arquivos[i];
      setEnviando({ atual: i + 1, total: arquivos.length });

      if (arquivo.size > MAX_BYTES_ORIGINAL) {
        falhas.push(`${arquivo.name} (${formatarMB(arquivo.size)} — máximo ${formatarMB(MAX_BYTES_ORIGINAL)})`);
        continue;
      }

      const { blob, ext } = await comprimirImagem(arquivo);
      // Nome único: sem isso, duas fotos com o mesmo nome se sobrescreveriam.
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;

      const { error: upErro } = await supabase.storage
        .from(BUCKET_PORTFOLIO)
        .upload(path, blob, { contentType: blob.type || "image/jpeg", cacheControl: "31536000" });

      if (upErro) {
        falhas.push(arquivo.name);
        continue;
      }

      const url = supabase.storage.from(BUCKET_PORTFOLIO).getPublicUrl(path).data.publicUrl;
      const { error: dbErro } = await supabase.from("portfolio_items").insert({ path, url });

      if (dbErro) {
        // O registro falhou: tira o arquivo do storage para não ficar lixo
        // invisível ocupando espaço.
        await supabase.storage.from(BUCKET_PORTFOLIO).remove([path]);
        falhas.push(arquivo.name);
      }
    }

    setEnviando(null);
    // Limpa o input para que escolher a MESMA foto de novo dispare o onChange.
    if (inputFotosRef.current) inputFotosRef.current.value = "";

    if (falhas.length > 0) {
      setPortfolioError(
        falhas.length === arquivos.length
          ? `Não conseguimos enviar: ${falhas.join(", ")}. Confira sua conexão e tente de novo.`
          : `Algumas fotos não subiram: ${falhas.join(", ")}. As demais foram enviadas.`
      );
    }

    await loadPortfolio();
  }

  // Apaga primeiro do storage e só então do banco: se a ordem fosse a
  // inversa e a segunda parte falhasse, o arquivo ficaria órfão sem
  // ninguém para encontrá-lo.
  async function handleApagarFoto(item) {
    if (apagandoId) return;
    if (!window.confirm("Apagar esta foto do mural? Isso não pode ser desfeito.")) return;

    setApagandoId(item.id);
    setPortfolioError(null);

    const { error: stErro } = await supabase.storage.from(BUCKET_PORTFOLIO).remove([item.path]);
    if (stErro) {
      setPortfolioError("Não conseguimos apagar a foto agora. Tente de novo em instantes.");
      setApagandoId(null);
      return;
    }

    const { error: dbErro } = await supabase.from("portfolio_items").delete().eq("id", item.id);
    if (dbErro) {
      setPortfolioError("A foto foi removida, mas o registro não. Recarregue a página e tente de novo.");
    }

    setApagandoId(null);
    await loadPortfolio();
  }

  // Trava o fundo enquanto o modal de agendamento está aberto. Depende do
  // booleano, não do objeto booking — senão a trava se refaria a cada tecla
  // digitada no formulário e a página pularia.
  useScrollLock(booking !== null);

  // A faixa sai de cena durante o agendamento: ela é fixa na base e cobriria
  // os botões da folha no celular.
  const instalacao = useInstalacaoPWA();
  // Quando visível, o .au-root ganha um padding de 74px na base para a faixa
  // não cobrir o rodapé nem o botão "Sair" da gestão.
  const mostrarFaixa = instalacao.visivel && booking === null;

  const days = useMemo(() => nextDays(14), []);

  // ── Serviços escolhidos e totais ──────────────────────────────────
  // Moram aqui em cima, e não junto do resto da tela, porque a duração do
  // combo é dependência do efeito logo abaixo. Declarados depois, a lista
  // de dependências leria uma const ainda não inicializada e quebraria.

  // Quem faz o quê virá da tabela barber_services num próximo passo.
  const availServices = services;

  // Os marcados, na ordem do cardápio e não na ordem dos cliques — assim o
  // resumo não embaralha a cada toque. Sai do availServices, então serviço
  // que o barbeiro não faz nunca entra na conta.
  const servicosEscolhidos = availServices.filter((s) => booking?.services?.includes(s.id));
  const totalPreco = servicosEscolhidos.reduce((soma, s) => soma + Number(s.preco ?? 0), 0);
  const totalDuracao = servicosEscolhidos.reduce((soma, s) => soma + Number(s.duracao_min ?? 0), 0);
  const resumoServicos = servicosEscolhidos.map((s) => s.nome.toLowerCase()).join(" + ");

  // Quanto tempo o horário precisa reservar. Enquanto nada está marcado (o
  // cliente ainda está no passo anterior), vale o passo da grade — é o mínimo
  // que qualquer atendimento ocupa. Ao marcar um serviço, o efeito abaixo
  // recalcula com a duração real.
  const duracaoCombo = totalDuracao > 0 ? totalDuracao : PASSO_MINUTOS;

  // Horários realmente livres do barbeiro escolhido, na data escolhida.
  const [slotsLivres, setSlotsLivres] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);

  // Valores primitivos como dependência: o objeto booking muda a cada tecla
  // digitada no formulário, e isso refaria a consulta sem necessidade.
  const barbeiroEscolhido = booking?.barber ?? null;
  const dataEscolhida = booking?.date ?? null;

  useEffect(() => {
    if (!barbeiroEscolhido || dataEscolhida === null) return;

    let cancelled = false;

    void (async () => {
      setSlotsLoading(true);
      setSlotsError(null);

      const dia = days[dataEscolhida];
      const possiveis = horariosDoDia(dia);

      // Dia fechado: nem consulta o banco.
      if (possiveis.length === 0) {
        if (!cancelled) {
          setSlotsLivres([]);
          setSlotsLoading(false);
        }
        return;
      }

      // Os intervalos ocupados vêm de uma FUNÇÃO do banco, não da tabela.
      //
      // O RLS de appointments só libera leitura para quem está logado — e
      // quem agenda não está. Lendo a tabela direto, o visitante recebia uma
      // lista vazia sem erro nenhum, e o app oferecia até os horários já
      // tomados. A função horarios_ocupados devolve apenas (inicio, minutos):
      // o visitante fica sabendo que a cadeira está ocupada, nunca de quem.
      //
      // p_dia usa chaveDiaLocal, que monta o AAAA-MM-DD com os mesmos
      // componentes de data que o toTimestampBR usa para gravar. A função
      // recorta o dia com o mesmo -03:00 fixo, então os dois lados concordam
      // sobre onde o dia começa e termina.
      const { data, error } = await supabase.rpc("horarios_ocupados", {
        p_barber_id: barbeiroEscolhido,
        p_dia: chaveDiaLocal(dia),
      });

      if (cancelled) return;

      if (error) {
        setSlotsError(error.message);
        setSlotsLivres([]);
        setSlotsLoading(false);
        return;
      }

      // Tudo vira minuto desde a meia-noite: comparar números é mais simples
      // e mais seguro do que comparar textos de hora ou objetos Date.
      //
      // Cancelado não vem: a função já filtra no banco, com a mesma condição
      // que a trava appointments_sem_sobreposicao usa. A regra passa a viver
      // num lugar só, em vez de repetida aqui e lá — repetida, uma das duas
      // acabaria mudando sozinha um dia.
      const ocupados = (data ?? []).map((r) => {
        const inicio = horaParaMinutos(formatHoraBR(r.inicio));
        return { inicio, fim: inicio + Number(r.minutos ?? PASSO_MINUTOS) };
      });

      const fechamento = fechamentoDoDia(dia);
      const ehHoje = chaveDiaLocal(dia) === chaveDiaBR(new Date().toISOString());
      const agora = minutosAgoraBR();

      setSlotsLivres(
        possiveis.filter((t) => {
          const inicio = horaParaMinutos(t);
          const fim = inicio + duracaoCombo;

          // 1. O combo inteiro tem que caber antes de fechar. horariosDoDia
          //    só garante que o INÍCIO cabe: 18:30 é oferecido mesmo quando o
          //    combo dura 70 min e a barbearia fecha às 19:00.
          if (fim > fechamento) return false;

          // 2. No dia de hoje, horário que já passou não vale.
          if (ehHoje && inicio <= agora) return false;

          // 3. Nenhuma sobreposição com o que já está marcado. Dois
          //    intervalos [a,b) e [c,d) se cruzam quando a < d E c < b.
          //    Repare que é "<" e não "<=": encostar não é cruzar, então um
          //    corte que termina 10:30 deixa o horário das 10:30 livre.
          return !ocupados.some((o) => inicio < o.fim && o.inicio < fim);
        })
      );
      setSlotsLoading(false);
    })();

    return () => { cancelled = true; };
    // duracaoCombo entra aqui: marcar ou desmarcar um serviço muda a duração
    // e, com ela, quais horários ainda cabem.
  }, [barbeiroEscolhido, dataEscolhida, days, duracaoCombo]);

  // Números do topo do dashboard, todos derivados da agenda real.
  const doBarbeiro = (lista) =>
    filtroBarbeiro === "todos" ? lista : lista.filter((a) => a.barber_id === filtroBarbeiro);
  const doDia = (lista) =>
    !filtroDataAtiva ? lista : lista.filter((a) => chaveDiaBR(a.data_hora) === filtroData);

  // Os números do topo acompanham barbeiro e data selecionados, para não
  // contradizerem a lista logo abaixo. A busca por telefone não entra: ela é
  // uma consulta pontual, não uma visão da agenda.
  const apptsDoFiltro = doBarbeiro(doDia(filtroDataPassada ? (historico ?? []) : appts));
  const faturamentoPrevisto = apptsDoFiltro.reduce((soma, a) => soma + totalDoAppt(a), 0);
  const aguardandoConfirmacao = apptsDoFiltro.filter((a) => a.status !== "confirmado").length;

  // A lista aplica os três filtros em sequência: telefone, data e barbeiro.
  const listaExibida = doBarbeiro(
    doDia(
      buscando
        ? (historico ?? []).filter((a) => soDigitos(a.cliente_telefone).includes(buscaDigitos))
        : precisaHistorico
          ? (historico ?? [])
          : appts
    )
  );
  const listaCarregando = precisaHistorico ? histLoading : apptsLoading;

  const startBooking = (barberId = null) => {
    setBookingError(null);
    setBooking({ step: barberId ? 1 : 0, barber: barberId, services: [], date: 0, time: null, name: "", phone: "" });
  };

  const closeBooking = () => {
    setBooking(null);
    setBookingError(null);
    setSaving(false);
  };

  const b = booking;

  // Grava o agendamento. A tela de sucesso só aparece se der certo.
  //
  // UMA chamada só: a função criar_agendamento insere em appointments E em
  // appointment_services dentro da mesma transação do banco. Ou grava tudo,
  // ou não grava nada — o que encerra a dívida da Parte 2, quando as duas
  // escritas eram separadas e podiam deixar o agendamento pela metade sem
  // jeito de desfazer.
  //
  // A duração NÃO vai daqui: o servidor soma services.duracao_min dos ids
  // recebidos. O navegador é a parte do sistema que qualquer pessoa
  // consegue editar, então ele não pode ser a fonte da verdade de um
  // número que alimenta a trava de sobreposição.
  async function confirmBooking() {
    if (saving) return;
    setSaving(true);
    setBookingError(null);

    const { error } = await supabase.rpc("criar_agendamento", {
      p_barber_id: b.barber,
      p_data_hora: toTimestampBR(days[b.date], b.time),
      p_cliente_nome: b.name.trim(),
      p_cliente_telefone: b.phone.trim(),
      p_service_ids: servicosEscolhidos.map((s) => s.id),
    });

    setSaving(false);

    if (error) {
      if (horarioJaOcupado(error)) {
        setBookingError("Ops, esse horário acabou de ser reservado. Escolha outro, por favor.");
        setBooking({ ...b, step: 2, time: null });
      } else {
        setBookingError("Não conseguimos concluir seu agendamento agora. Tente de novo em alguns instantes.");
      }
      return;
    }

    setBooking({ ...b, step: 4 });
  }
  const barberObj = b?.barber ? barbers.find((x) => x.id === b.barber) : null;
  // Marca/desmarca um serviço. Nenhum horário é recalculado aqui: a duração
  // só passa a mexer nos horários oferecidos na Parte 3.
  const toggleService = (id) => {
    setBookingError(null);
    setBooking((atual) => ({
      ...atual,
      services: atual.services.includes(id)
        ? atual.services.filter((x) => x !== id)
        : [...atual.services, id],
    }));
  };

  // Só libera o "Continuar" se o horário escolhido ainda estiver na lista.
  // Protege o caso de trocar de barbeiro depois de já ter escolhido a hora.
  const horarioSelecionadoValido = Boolean(b?.time && slotsLivres.includes(b.time));

  const steps = ["Profissional", "Serviços", "Data e horário", "Seus dados", "Pronto"];

  return (
    <div className="au-root" style={mostrarFaixa ? { paddingBottom: 74 } : undefined}>
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
            <div style={{ marginTop: 44 }}>
              <button className="au-btn" onClick={() => startBooking()}>Agendar horário</button>
            </div>
          </header>

          <section className="au-sec">
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

          {portfolio.length > 0 && (
            <section className="au-sec" style={{ paddingTop: 0 }}>
              <div className="au-sec-head">
                <h2 className="au-serif">Nossos trabalhos</h2>
                <p>Alguns cortes que saíram daqui. O próximo pode ser o seu.</p>
              </div>
              <div className="au-gal">
                {portfolio.map((p) => (
                  <figure className="au-gal-item" key={p.id}>
                    <img src={p.url} alt="Corte feito na Áurea Barbearia" loading="lazy" />
                  </figure>
                ))}
              </div>
            </section>
          )}

          <section className="au-sec" style={{ paddingTop: 0 }}>
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
        checkingSession ? (
          <div className="au-login">
            <div className="au-hint">Carregando…</div>
          </div>
        ) : !session ? (
          <div className="au-login">
            <h2 className="au-serif">Área de gestão</h2>
            <p>Entre para ver a agenda do dia.</p>
            {authError && <div className="au-alert">{authError}</div>}
            <div className="au-field"><label>E-mail</label><input type="email" autoComplete="username" placeholder="voce@barbearia.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="au-field"><label>Senha</label><input type="password" autoComplete="current-password" placeholder="Sua senha" value={senha} onChange={(e) => setSenha(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }} /></div>
            <button className="au-btn" style={{ width: "100%", justifyContent: "center" }} disabled={!email || !senha || signingIn} onClick={handleLogin}>{signingIn ? "Entrando…" : "Entrar"}</button>
            <div className="au-hint">Acesso restrito à equipe da barbearia.</div>
          </div>
        ) : (
          <div className="au-dash">
            <div className="au-dash-head">
              <h2 className="au-serif">{aba === "agenda" ? "Agenda" : "Trabalhos"}</h2>
              {aba === "agenda" && (
                <div className="au-dash-date">{WEEKDAYS[new Date().getDay()].toUpperCase()}, {new Date().getDate()} {MONTHS[new Date().getMonth()].toUpperCase()}</div>
              )}
            </div>

            <div className="au-tabs">
              <button className={`au-tab ${aba === "agenda" ? "on" : ""}`} onClick={() => setAba("agenda")}>Agenda</button>
              <button className={`au-tab ${aba === "trabalhos" ? "on" : ""}`} onClick={() => setAba("trabalhos")}>Trabalhos</button>
            </div>

            {aba === "trabalhos" ? (
              <>
                <label className="au-upload">
                  <input
                    ref={inputFotosRef}
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={enviando !== null}
                    onChange={(e) => handleUploadFotos(e.target.files)}
                  />
                  <span className="au-upload-icon">＋</span>
                  <span className="au-upload-t">{enviando ? `Enviando ${enviando.atual} de ${enviando.total}…` : "Adicionar fotos"}</span>
                  <span className="au-upload-s">
                    {enviando
                      ? "Não feche esta tela."
                      : `Só imagens. Elas são reduzidas automaticamente antes de subir (máx. ${formatarMB(MAX_BYTES_ORIGINAL)} por foto).`}
                  </span>
                </label>

                {portfolioError && <div className="au-note err">{portfolioError}</div>}

                {portfolio.length === 0 ? (
                  <div className="au-note">Nenhuma foto no mural ainda. As que você enviar aparecem na home, na seção “Nossos trabalhos”.</div>
                ) : (
                  <div className="au-gal">
                    {portfolio.map((p) => (
                      <figure className="au-gal-item" key={p.id}>
                        <img src={p.url} alt="" loading="lazy" />
                        <button
                          className="au-gal-del"
                          aria-label="Apagar foto"
                          disabled={apagandoId !== null}
                          onClick={() => handleApagarFoto(p)}
                        >
                          {apagandoId === p.id ? "…" : "✕"}
                        </button>
                      </figure>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
            <div className="au-stats">
              <div className="au-stat"><div className="n">{apptsDoFiltro.length}</div><div className="l">{filtroDataAtiva ? "Agendamentos no dia" : "Próximos agendamentos"}</div></div>
              <div className="au-stat"><div className="n">R$ {faturamentoPrevisto.toLocaleString("pt-BR")}</div><div className="l">{filtroDataPassada ? "Faturamento do dia" : "Faturamento previsto"}</div></div>
              <div className="au-stat"><div className="n">{aguardandoConfirmacao}</div><div className="l">Aguardando confirmação</div></div>
              <div className="au-stat"><div className="n">{barbers.length}</div><div className="l">Barbeiros ativos</div></div>
            </div>
            <div className="au-chips">
              <button className={`au-chip ${filtroBarbeiro === "todos" ? "on" : ""}`} onClick={() => setFiltroBarbeiro("todos")}>Todos</button>
              {barbers.map((bb) => (
                <button key={bb.id} className={`au-chip ${filtroBarbeiro === bb.id ? "on" : ""}`} onClick={() => setFiltroBarbeiro(bb.id)}>
                  {bb.nome.split(" ")[0]}
                </button>
              ))}
            </div>

            <div className="au-chips">
              <button className={`au-chip ${!filtroDataAtiva ? "on" : ""}`} onClick={() => setFiltroData("proximos")}>Próximos</button>
              <button className={`au-chip ${filtroData === hojeBR ? "on" : ""}`} onClick={() => setFiltroData(hojeBR)}>Hoje</button>
              <button className={`au-chip ${filtroData === amanhaBR ? "on" : ""}`} onClick={() => setFiltroData(amanhaBR)}>Amanhã</button>
              <input
                type="date"
                className={`au-chip-date ${filtroDataAtiva ? "on" : ""}`}
                aria-label="Filtrar por uma data específica"
                value={filtroDataAtiva ? filtroData : ""}
                onChange={(e) => setFiltroData(e.target.value || "proximos")}
              />
            </div>

            <div className="au-search">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Buscar agendamentos por telefone"
                placeholder="Buscar por telefone (inclui histórico)"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              {busca && (
                <button className="au-search-clear" aria-label="Limpar busca" onClick={() => setBusca("")}>✕</button>
              )}
            </div>

            {apptsError && <div className="au-note err">Não foi possível carregar a agenda: {apptsError}</div>}
            {histError && <div className="au-note err">Não foi possível buscar o histórico: {histError}</div>}
            <div className="au-appts">
              {listaCarregando ? (
                <div className="au-note" style={{ padding: "22px" }}>{buscando ? "Buscando…" : "Carregando agenda…"}</div>
              ) : listaExibida.length === 0 ? (
                <div className="au-note" style={{ padding: "22px" }}>
                  {buscando
                    ? "Nenhum agendamento encontrado para esse telefone."
                    : filtroDataAtiva || filtroBarbeiro !== "todos"
                      ? "Nenhum agendamento para esses filtros."
                      : "Nenhum agendamento por aqui ainda."}
                </div>
              ) : listaExibida.map((a) => {
                const fim = fimHoraBR(a);
                return (
                <div className="au-appt" key={a.id}>
                  <div>
                    <div className="au-appt-time au-serif">{formatHoraBR(a.data_hora)}</div>
                    {/* Sem duração confiável, mostra só o início — como antes. */}
                    {fim && <div className="au-appt-fim">até {fim}</div>}
                    {/* Sem serviços na tabela de ligação não há valor a mostrar:
                        melhor omitir do que exibir um "R$ 0,00" enganoso. */}
                    {a.services?.length > 0 && (
                      <div className="au-appt-valor">{moedaBR(totalDoAppt(a))}</div>
                    )}
                  </div>
                  <div>
                    <div className="au-appt-client">{a.cliente_nome}</div>
                    <div className="au-appt-meta">
                      {chaveDiaBR(a.data_hora) !== hojeBR && `${formatDiaCurtoBR(a.data_hora)} · `}
                      {/* filter(Boolean) evita " · " solto se algum pedaço faltar. */}
                      {[nomesDosServicos(a), a.barbers?.nome, a.cliente_telefone].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <span className={`au-badge ${a.status === "confirmado" ? "ok" : "pend"}`}>{a.status}</span>
                </div>
                );
              })}
            </div>
              </>
            )}

            <div style={{ textAlign: "center", marginTop: 24 }}>
              <button className="au-btn au-btn-ghost" onClick={handleLogout}>Sair</button>
            </div>
          </div>
        )
      )}

      {b && (
        <div className="au-ov" onClick={(e) => { if (e.target.classList.contains("au-ov")) closeBooking(); }}>
          <div className="au-sheet">
            <div className="au-sheet-head">
              <div>
                <div className="au-step-label">{b.step < 4 ? `Passo ${b.step + 1} de 4` : "Confirmado"}</div>
                <h3 className="au-serif">{steps[b.step]}</h3>
              </div>
              <button className="au-x" onClick={closeBooking}>✕</button>
            </div>
            <div className="au-sheet-body">
              {bookingError && <div className="au-alert">{bookingError}</div>}

              {b.step === 0 && barbers.map((bb) => (
                <button className="au-pick" key={bb.id} onClick={() => setBooking({ ...b, barber: bb.id, services: [], time: null, step: 1 })}>
                  <img src={bb.foto_url} alt="" />
                  <div className="au-pick-main">
                    <div className="au-pick-t">{bb.nome}</div>
                    <div className="au-pick-s">{bb.especialidades.join(" · ")}</div>
                  </div>
                </button>
              ))}

              {b.step === 1 && (
                <>
                  <div className="au-hint">
                    Marque quantos serviços quiser — todos serão feitos por {barberObj?.nome.split(" ")[0]} no mesmo horário.
                  </div>
                  {availServices.map((s) => {
                    const marcado = b.services.includes(s.id);
                    return (
                      <button
                        className={`au-pick ${marcado ? "sel" : ""}`}
                        key={s.id}
                        aria-pressed={marcado}
                        onClick={() => toggleService(s.id)}
                      >
                        <span className="au-pick-cb" aria-hidden="true">✓</span>
                        <div className="au-pick-main">
                          <div className="au-pick-t">{s.nome}</div>
                          <div className="au-pick-s">{s.duracao_min} min · {s.descricao}</div>
                        </div>
                        <div className="au-pick-p au-serif">R$ {s.preco}</div>
                      </button>
                    );
                  })}
                  <div className="au-pickbar">
                    <div className="au-pickbar-row">
                      <span className="au-pickbar-l">
                        {servicosEscolhidos.length === 0
                          ? "Nenhum serviço marcado"
                          : `${servicosEscolhidos.length} ${servicosEscolhidos.length === 1 ? "serviço" : "serviços"} · ${totalDuracao} min`}
                      </span>
                      <span className="au-pickbar-p">R$ {precoBR(totalPreco)}</span>
                    </div>
                    <button
                      className="au-btn"
                      style={{ width: "100%", justifyContent: "center" }}
                      disabled={servicosEscolhidos.length === 0}
                      onClick={() => setBooking({ ...b, step: 2 })}
                    >
                      Continuar
                    </button>
                  </div>
                </>
              )}

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
                  <div className="au-slots-area">
                    {slotsLoading ? (
                      <div className="au-note">Carregando horários…</div>
                    ) : slotsError ? (
                      <div className="au-note err">Não foi possível ver os horários agora. Tente de novo em instantes.</div>
                    ) : estaFechado(days[b.date]) ? (
                      <div className="au-note">A barbearia não abre neste dia.</div>
                    ) : slotsLivres.length === 0 ? (
                      <div className="au-note">Nenhum horário disponível neste dia. Tente outra data.</div>
                    ) : (
                      <div className="au-slots">
                        {slotsLivres.map((t) => (
                          <button key={t} className={`au-slot ${b.time === t ? "sel" : ""}`} onClick={() => { setBookingError(null); setBooking({ ...b, time: t }); }}>{t}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="au-btn" style={{ width: "100%", justifyContent: "center", marginTop: 22 }} disabled={!horarioSelecionadoValido} onClick={() => setBooking({ ...b, step: 3 })}>Continuar</button>
                </>
              )}

              {b.step === 3 && (
                <>
                  <div className="au-summary">
                    <div className="au-sumrow"><span>Profissional</span><span>{barberObj?.nome}</span></div>
                    <div className="au-sumsvcs">
                      {servicosEscolhidos.map((s) => (
                        <div className="au-sumrow svc" key={s.id}><span>{s.nome}</span><span>R$ {s.preco}</span></div>
                      ))}
                    </div>
                    <div className="au-sumrow"><span>Quando</span><span>{days[b.date].getDate()} {MONTHS[days[b.date].getMonth()]} · {b.time}</span></div>
                    <div className="au-sumrow"><span>Duração</span><span>{totalDuracao} min</span></div>
                    <div className="au-sumrow total"><span>Total</span><span>R$ {precoBR(totalPreco)}</span></div>
                  </div>
                  <div className="au-field"><label>Seu nome</label><input value={b.name} onChange={(e) => setBooking({ ...b, name: e.target.value })} placeholder="Como devemos te chamar?" /></div>
                  <div className="au-field"><label>Telefone / WhatsApp</label><input type="tel" inputMode="numeric" autoComplete="tel" value={b.phone} onChange={(e) => setBooking({ ...b, phone: mascaraTelefone(e.target.value) })} placeholder="(21) 90000-0000" /></div>
                  <button className="au-btn" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={!b.name.trim() || !telefoneValido(b.phone) || saving} onClick={confirmBooking}>{saving ? "Confirmando…" : "Confirmar agendamento"}</button>
                </>
              )}

              {b.step === 4 && (
                <div className="au-done">
                  <div className="au-check">✓</div>
                  <h3 className="au-serif">Horário reservado</h3>
                  <p>{b.name.split(" ")[0]}, seu {resumoServicos} com {barberObj?.nome.split(" ")[0]} está marcado para <strong style={{ color: "var(--cream)" }}>{days[b.date].getDate()} {MONTHS[days[b.date].getMonth()]} às {b.time}</strong>. Enviaremos um lembrete no WhatsApp.</p>
                  <button className="au-btn" style={{ marginTop: 26 }} onClick={closeBooking}>Concluir</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {mostrarFaixa && (
        <FaixaInstalar
          iOS={instalacao.iOS}
          onInstalar={instalacao.instalar}
          onDispensar={instalacao.dispensar}
        />
      )}
    </div>
  );
}