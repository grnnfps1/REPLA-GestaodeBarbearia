# REPLA — Sistema de Gestão de Barbearia

## Contexto
MVP para VALIDAÇÃO de ideia (SaaS de barbearia, mas começando com UMA barbearia só). Fundador: Gabriel, iniciante em programação, aprendendo com IA guiando. Explique o essencial de forma simples quando fizer algo novo.

## Objetivo do MVP
Uma barbearia real usar o sistema para receber agendamentos de clientes de verdade. Nada além disso agora — sem multi-tenant, sem theme engine, sem white label, sem loja de apps.

## Stack decidida
- React + Vite (base já criada e rodando)
- Supabase (banco de dados, autenticação, storage de fotos)
- PWA (app instalável na tela do celular — configurar manifest + service worker)
- Deploy: definir depois (provavelmente Vercel, grátis)

## Distribuição
PWA instalável (custo zero). NÃO empacotar como app nativo agora. Código deve ficar pronto para virar Capacitor no futuro, se validar.

## Escopo do MVP (só isto)
1. App Cliente (SEM login): ver a barbearia, ver barbeiros (foto, bio, especialidades, Instagram, WhatsApp), ver serviços, e AGENDAR (barbeiro → serviço → data → horário → nome + telefone → confirmação).
2. Área de Gestão (COM login): dono/barbeiro entra e vê a agenda do dia.

## Papéis de acesso
Apenas dois: Dono (vê tudo) e Barbeiro (vê a própria agenda e edita o próprio perfil).

## Modelo de dados (5 tabelas)
- barbers: nome, foto, bio, especialidade, instagram, whatsapp, ativo
- services: nome, descrição, preço, duração_min, ativo
- barber_services: quais serviços cada barbeiro faz (relação)
- working_hours: jornada do barbeiro (dia_semana, hora_inicio, hora_fim)
- appointments: barbeiro, serviço, data_hora, cliente_nome, cliente_telefone, status
IMPORTANTE: o bloqueio de horário duplo deve ser garantido no banco (constraint), não só na tela.

## Estética (premium, escuro/dourado) — JÁ IMPLEMENTADA em src/App.jsx
- Paleta: espresso quente (#171310), ouro fosco (#c9a35b), creme (#ece1cf)
- Fontes: Fraunces (títulos, serifada) + Inter (texto)
- Nome de demonstração: "Áurea Barbearia" (trocar pelo nome real depois)

## Estado atual do projeto
- Projeto React + Vite criado e rodando em localhost:5173
- src/App.jsx já contém a base visual completa (app cliente + área de gestão) com dados FALSOS (em memória), incluindo: hero, cards de barbeiros, cardápio de serviços, fluxo de agendamento em 4 passos, login simulado e agenda do dia.
- src/index.css contém APENAS a base mínima (html/body/#root a 100% de largura e fundo espresso). Todo o visual vive no bloco CSS dentro de src/App.jsx. O CSS de fábrica do Vite foi removido (limitava #root a 1126px) e src/App.css foi apagado por ser código morto.
- Layout pretendido: a página ocupa 100% da largura; só as seções internas (.au-sec, .au-dash) têm max-width de 1080px centralizado.
- Já versionado no GitHub: github.com/grnnfps1/REPLA-GestaodeBarbearia
- PRÓXIMO PASSO: conectar o Supabase para os dados serem reais.

## Como trabalhamos
Um passo por vez. Antes de decisões grandes, me explique e peça aprovação. Não avance sozinho vários passos. Priorize custo baixo sem sacrificar segurança. Explique o essencial de forma simples, pois estou aprendendo.
