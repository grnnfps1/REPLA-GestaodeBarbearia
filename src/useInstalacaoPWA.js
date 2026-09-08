import { useState, useEffect, useCallback } from "react";

/**
 * Decide se a faixa de instalação do PWA deve aparecer, e como.
 *
 * Android e desktop têm instalação programável: o navegador dispara
 * 'beforeinstallprompt', a gente guarda o evento e um botão abre o prompt
 * nativo. O iOS não tem esse evento nem API equivalente — lá o único caminho
 * é o usuário passar pelo menu Compartilhar, então só resta instruir.
 */

const CHAVE_DISPENSADO = "aurea:instalar-dispensado";

// localStorage pode lançar exceção (modo privado, cookies bloqueados). Se não
// der para persistir, a faixa some só na sessão atual — melhor do que quebrar.
function lerDispensado() {
  try {
    return localStorage.getItem(CHAVE_DISPENSADO) === "1";
  } catch {
    return false;
  }
}

function gravarDispensado() {
  try {
    localStorage.setItem(CHAVE_DISPENSADO, "1");
  } catch {
    // Sem persistência: a faixa volta na próxima visita. Aceitável.
  }
}

function estaInstalado() {
  const modoApp = window.matchMedia?.("(display-mode: standalone)").matches;
  // navigator.standalone é a forma antiga, só do Safari no iOS.
  return Boolean(modoApp || window.navigator.standalone);
}

function detectarIOS() {
  const ua = window.navigator.userAgent;
  // iPadOS 13+ se identifica como Macintosh; os pontos de toque o entregam.
  const iPadDisfarcado = /Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadDisfarcado;
}

export function useInstalacaoPWA() {
  const [evento, setEvento] = useState(null);
  const [dispensado, setDispensado] = useState(lerDispensado);
  const [instalado, setInstalado] = useState(estaInstalado);
  // Espera um pouco antes de aparecer: quem acabou de abrir o site ainda não
  // sabe se quer instalar.
  const [passouEspera, setPassouEspera] = useState(false);

  const iOS = detectarIOS();

  useEffect(() => {
    const aoPoderInstalar = (e) => {
      // Sem isto o Chrome mostra o próprio banner e o nosso fica redundante.
      e.preventDefault();
      setEvento(e);
    };
    const aoInstalar = () => {
      setInstalado(true);
      setEvento(null);
      gravarDispensado();
    };

    window.addEventListener("beforeinstallprompt", aoPoderInstalar);
    window.addEventListener("appinstalled", aoInstalar);

    const espera = setTimeout(() => setPassouEspera(true), 2500);

    return () => {
      window.removeEventListener("beforeinstallprompt", aoPoderInstalar);
      window.removeEventListener("appinstalled", aoInstalar);
      clearTimeout(espera);
    };
  }, []);

  const dispensar = useCallback(() => {
    setDispensado(true);
    gravarDispensado();
  }, []);

  const instalar = useCallback(async () => {
    if (!evento) return;
    evento.prompt();
    await evento.userChoice;
    // O evento só serve uma vez. Some com a faixa tendo o usuário aceitado ou
    // recusado — insistir depois de um "não" é incômodo.
    setEvento(null);
    setDispensado(true);
    gravarDispensado();
  }, [evento]);

  const visivel =
    passouEspera && !instalado && !dispensado && (iOS || Boolean(evento));

  return { visivel, iOS, instalar, dispensar };
}
