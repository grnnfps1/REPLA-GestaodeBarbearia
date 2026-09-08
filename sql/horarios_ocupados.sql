-- =====================================================================
-- HORARIOS OCUPADOS DE UM BARBEIRO NUM DIA — PARTE 3.4 (banco)
--
-- O problema que isto resolve:
--
-- O RLS de appointments so libera SELECT para quem esta logado. Isso e
-- proposital e esta certo: a agenda tem nome e telefone de cliente, e
-- ninguem de fora pode ler isso.
--
-- So que o app precisa saber quais horarios estao ocupados para nao
-- oferecer o que nao existe. Hoje ele TENTA ler appointments direto e
-- recebe uma lista vazia — silenciosamente. Resultado: para o cliente
-- sem login, o app oferece TODOS os horarios, inclusive os tomados.
-- (Da para confirmar: um GET em /appointments com a chave anon responde
--  200 com "Content-Range: */0".)
--
-- A saida NAO e abrir o SELECT de appointments — isso exporia a agenda
-- inteira com nome e telefone. E abrir uma fresta do tamanho exato da
-- necessidade: uma funcao que devolve SO "das 10:00 por 70 minutos",
-- sem dizer de quem e.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
--
-- >>> AINDA NAO FOI EXECUTADO. Revise antes de rodar. <<<
-- =====================================================================


-- #####################################################################
-- PASSO 0 — PRE-VOO (so leitura)
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0.1 — O RLS esta ligado e o dono da tabela consegue passar por cima?
--
-- Esperado:
--   rls_ligado   = true   (o RLS protege a tabela)
--   rls_forcado  = false  (o DONO da tabela nao e afetado por ele)
--   dono         = postgres
--
-- rls_forcado e o que decide se este arquivo funciona. Uma funcao
-- SECURITY DEFINER roda com os poderes do dono, e o dono normalmente
-- ignora o RLS. Mas se alguem tiver rodado "alter table ... force row
-- level security", nem o dono escapa, e a funcao voltaria vazia igual
-- ao app hoje. Se vier true, me avise antes de continuar.
-- ---------------------------------------------------------------------
select
  c.relrowsecurity      as rls_ligado,
  c.relforcerowsecurity as rls_forcado,
  pg_get_userbyid(c.relowner) as dono
from pg_class c
where c.oid = 'public.appointments'::regclass;


-- ---------------------------------------------------------------------
-- 0.2 — Confirmando o problema: o visitante enxerga alguma coisa?
--
-- "set local role anon" faz a sessao fingir ser o visitante. O rollback
-- no fim devolve tudo ao normal (e nada e alterado de qualquer forma).
--
-- Esperado: 0. Se der mais que 0, existe uma politica de SELECT publica
-- em appointments que eu nao conhecia — me avise, muda o desenho.
-- ---------------------------------------------------------------------
begin;
set local role anon;
select count(*) as o_visitante_enxerga from public.appointments;
rollback;


-- #####################################################################
-- PASSO 1 — A FUNCAO
-- #####################################################################

-- ---------------------------------------------------------------------
-- A ASSINATURA — por que (uuid, date) e nao uma janela de timestamps
--
-- Considerei receber inicio e fim prontos, ja que o app calcula esses
-- limites hoje. Ficaria com (p_barber_id, p_inicio, p_fim). Vantagem:
-- a regra de fuso viveria em um lugar so, o App.jsx.
--
-- Preferi (p_barber_id, p_dia) por causa do CONTRATO: um dia, e ponto.
-- Com a janela aberta, quem chama pode pedir dez anos de uma vez e usar
-- a funcao para varrer a ocupacao inteira da barbearia numa tacada. Nao
-- vazaria dado pessoal, mas nao ha motivo para permitir. Com uma data,
-- varrer o ano exige 365 chamadas — o mesmo esforco de clicar dia a dia
-- na tela, que qualquer pessoa ja pode fazer.
--
-- O preco e ter a regra de fuso em dois lugares. Por isso o cuidado
-- abaixo.
--
-- O FUSO — por que -03:00 na mao e nao 'America/Sao_Paulo'
--
-- O App.jsx fixa -03:00 em toda parte, de proposito (ver o comentario
-- do toTimestampBR): o horario e o da LOJA, nao o do celular de quem
-- agenda. Se aqui eu usasse o fuso nomeado e um dia o Brasil voltasse a
-- ter horario de verao, o banco passaria a cortar o dia numa hora e o
-- app noutra, e apareceriam agendamentos fantasma na virada do dia.
-- Usando o mesmo -03:00 fixo, os dois so podem errar juntos — e se um
-- dia isso mudar, muda nos dois, de proposito.
--
-- "at time zone interval '-03:00'" e nao "at time zone '-03:00'": com
-- TEXTO, o Postgres pode interpretar o sinal ao contrario (convencao
-- POSIX, onde UTC-3 significa +3). Com INTERVALO, o sinal e o normal,
-- sem ambiguidade.
--
-- OS NOMES DE SAIDA — inicio e minutos, nao data_hora e duracao_min
--
-- Os nomes do RETURNS TABLE entram no escopo do corpo da funcao. Usar
-- os mesmos nomes das colunas convida erro de "column reference is
-- ambiguous". Nomes diferentes eliminam a duvida.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- SEGURANCA — por que DEFINER aqui, sendo que na criar_agendamento eu
-- argumentei justamente o contrario
--
-- Nao e incoerencia, e a mesma regra aplicada a dois casos diferentes:
-- dar o MINIMO de poder que resolve.
--
--   criar_agendamento: tudo que ela faz (inserir agendamento, inserir
--   servicos, ler o cardapio) o visitante JA pode fazer sozinho. Poder
--   extra ali seria sobra, e sobra e risco — um "select from
--   appointments" acrescentado por engano vazaria a agenda. INVOKER.
--
--   horarios_ocupados: o visitante NAO pode ler appointments, e o
--   objetivo e exatamente esse. Com INVOKER a funcao voltaria vazia,
--   igual ao app hoje. Nao existe caminho INVOKER que funcione sem
--   afrouxar o RLS da tabela, que e pior. DEFINER.
--
-- Por que DEFINER e seguro NESTE caso — quatro razoes:
--
-- 1. A saida e estreita por construcao. Duas colunas: quando comeca e
--    quantos minutos dura. Nao ha nome, telefone, servico, status, nem
--    o id do agendamento. Nao ha o que vazar porque nada pessoal chega
--    a sair da funcao.
--
-- 2. Ela nao aceita filtro do chamador. O WHERE e fixo e os parametros
--    sao TIPADOS (uuid e date), nao texto colado dentro de um SQL. Nao
--    ha EXECUTE dinamico. Ninguem consegue transformar isto em "me
--    devolva a tabela inteira".
--
-- 3. So le. E "language sql" com um unico SELECT e marcada STABLE — nao
--    consegue escrever nem que queira.
--
-- 4. search_path fixado em vazio e todo objeto escrito com "public." na
--    frente. Sem isso, alguem com permissao de criar schema poderia
--    plantar uma tabela chamada "appointments" noutro lugar e fazer a
--    funcao — que roda como dono — ler o que nao devia. Com DEFINER
--    esse cuidado deixa de ser boa pratica e vira obrigacao.
--
-- E o que o visitante ganha de fato? Saber que a cadeira do Rafael esta
-- ocupada das 10:00 as 11:10. Que e precisamente o que a tela de
-- agendamento mostra para qualquer um que abrir o site. Nao ha
-- informacao nova sendo exposta — so estamos entregando de um jeito
-- correto o que a interface ja precisa dizer.
-- ---------------------------------------------------------------------

create or replace function public.horarios_ocupados(
  p_barber_id uuid,
  p_dia       date
)
returns table (inicio timestamptz, minutos integer)
language sql
stable
security definer
set search_path = ''
as $$
  select a.data_hora, a.duracao_min
  from public.appointments a
  where a.barber_id = p_barber_id
    -- Janela do dia no fuso da loja: das 00:00 de p_dia ate as 00:00 do
    -- dia seguinte, com o fim de fora (>= e <), para nao pegar duas vezes
    -- um agendamento exatamente na virada.
    and a.data_hora >=  p_dia     ::timestamp at time zone interval '-03:00'
    and a.data_hora <  (p_dia + 1)::timestamp at time zone interval '-03:00'
    -- Espelha o WHERE da trava appointments_sem_sobreposicao: cancelado
    -- nao ocupa a cadeira, e status nulo ocupa. As duas regras precisam
    -- concordar, senao o app esconde horario que o banco aceitaria — ou,
    -- pior, oferece um que ele vai recusar.
    and a.status is distinct from 'cancelado'
  order by a.data_hora;
$$;


comment on function public.horarios_ocupados(uuid, date) is
  'Intervalos ocupados de um barbeiro num dia, para o app calcular horarios '
  'livres sem login. Devolve apenas (inicio, minutos) — nenhum dado pessoal. '
  'SECURITY DEFINER de proposito: o visitante nao tem SELECT em appointments.';


-- ---------------------------------------------------------------------
-- PASSO 2 — QUEM PODE CHAMAR
--
-- Mesmo ritual da criar_agendamento: tira de PUBLIC e devolve so aos
-- dois papeis que existem. Aqui isso pesa mais, porque a funcao e
-- DEFINER — nao queremos que um papel futuro herde acesso sem ninguem
-- decidir isso.
-- ---------------------------------------------------------------------
revoke all on function public.horarios_ocupados(uuid, date) from public;

grant execute on function public.horarios_ocupados(uuid, date)
  to anon, authenticated;


-- ---------------------------------------------------------------------
-- PASSO 3 — AVISAR A API
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFICACOES — rode depois
-- =====================================================================

-- ---------------------------------------------------------------------
-- V1) A funcao existe, e DEFINER e tem o search_path fixado?
--
-- Esperado:
--   retorno    = TABLE(inicio timestamp with time zone, minutos integer)
--   seguranca  = definer
--   config     = {search_path=""}
--
-- Se config vier vazio, o "set search_path" nao pegou — nao use a
-- funcao assim, me avise.
-- ---------------------------------------------------------------------
select
  p.proname                                 as nome,
  pg_get_function_identity_arguments(p.oid) as parametros,
  pg_get_function_result(p.oid)             as retorno,
  case when p.prosecdef then 'definer' else 'invoker' end as seguranca,
  p.provolatile                             as volatilidade,
  p.proconfig                               as config,
  pg_get_userbyid(p.proowner)               as dono
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'horarios_ocupados';


-- ---------------------------------------------------------------------
-- V2) NAO devolve dado pessoal — a prova formal.
--
-- Lista as colunas de saida declaradas. Devem ser EXATAMENTE duas:
-- inicio e minutos. Se aparecer qualquer outra coisa, pare.
--
-- Esta verificacao vale mais que olhar um resultado: ela olha o
-- CONTRATO da funcao, entao nenhum dado pessoal pode sair nem por
-- acidente, com qualquer entrada.
-- ---------------------------------------------------------------------
select unnest(p.proargnames) as coluna_de_saida
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'horarios_ocupados';
-- (as duas primeiras linhas sao os parametros de entrada,
--  p_barber_id e p_dia; as duas ultimas, a saida: inicio e minutos)


-- ---------------------------------------------------------------------
-- V3) Quem pode executar? Devem aparecer anon e authenticated.
-- ---------------------------------------------------------------------
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'horarios_ocupados'
order by grantee;


-- ---------------------------------------------------------------------
-- V4) Devolve os intervalos certos? (com dado de verdade)
--
-- Troque a data por um dia que voce SABE que tem agendamento, e o
-- barbeiro pelo que voce quer olhar. Compare com a agenda na tela: os
-- horarios tem que bater, e os minutos tem que ser a duracao somada dos
-- servicos daquele agendamento.
-- ---------------------------------------------------------------------
select * from public.horarios_ocupados(
  (select id from public.barbers order by id limit 1),
  current_date
);


-- ---------------------------------------------------------------------
-- V5) Cancelado nao ocupa, e a janela do dia esta certa?
--
-- Cria tres agendamentos em 2099 e conta o que a funcao enxerga.
-- Esperado: SO o das 10:00. O cancelado nao entra, e o do dia seguinte
-- tambem nao.
--
-- Tudo em begin/rollback: nada fica gravado.
-- ---------------------------------------------------------------------
begin;

insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-05-01 10:00:00-03', 70, 'Teste ocupado', '(21) 90000-0000', 'confirmado'),
  ((select id from public.barbers order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-05-01 14:00:00-03', 30, 'Teste cancelado', '(21) 90000-0000', 'cancelado'),
  ((select id from public.barbers order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-05-02 10:00:00-03', 30, 'Teste outro dia', '(21) 90000-0000', 'confirmado');

-- DEVE trazer exatamente 1 linha: 2099-05-01 10:00 -03, 70 minutos.
select * from public.horarios_ocupados(
  (select id from public.barbers order by id limit 1),
  date '2099-05-01'
);

rollback;


-- ---------------------------------------------------------------------
-- V6) O TESTE QUE IMPORTA — o visitante consegue?
--
-- Aqui esta o coracao do desenho, nas duas consultas lado a lado, na
-- mesma sessao e com o mesmo papel:
--
--   leitura_direta   -> tem que dar 0    (o RLS continua protegendo)
--   pela_funcao      -> tem que dar > 0  (a fresta funciona)
--
-- Se os dois derem 0, a funcao nao esta como DEFINER ou o 0.1 acusou
-- rls_forcado = true.
-- Se leitura_direta der mais que 0, existe politica de SELECT publica
-- em appointments e o RLS nao esta protegendo o que deveria.
--
-- Use um dia que voce sabe que tem agendamento.
-- ---------------------------------------------------------------------
begin;
set local role anon;

select
  (select count(*) from public.appointments)                        as leitura_direta,
  (select count(*) from public.horarios_ocupados(
      (select id from public.barbers order by id limit 1),
      current_date))                                                as pela_funcao;

rollback;


-- =====================================================================
-- NOTAS
--
-- (1) Depois desta funcao, o App.jsx para de consultar appointments
--     direto no fluxo de agendamento. A area de gestao continua lendo a
--     tabela normalmente — la o dono esta logado e PRECISA ver nome e
--     telefone.
--
-- (2) A funcao devolve o dia inteiro, inclusive horarios fora da
--     jornada. Filtrar por horario de funcionamento continua sendo
--     tarefa do app, que e quem conhece o HORARIO_FUNCIONAMENTO. Se um
--     dia isso virar a tabela working_hours prevista no CLAUDE.md, o
--     filtro pode migrar para ca.
--
-- (3) p_dia nulo devolve zero linhas (as comparacoes com nulo nao dao
--     verdadeiro). O app sempre manda uma data, entao isso e so uma
--     nota — nao ha erro a tratar.
--
-- (4) Isto NAO substitui a trava appointments_sem_sobreposicao. Esta
--     funcao evita OFERECER horario impossivel; a trava impede GRAVAR
--     dois no mesmo lugar quando duas pessoas clicam no mesmo segundo.
--     Uma cuida da experiencia, a outra do dado.
-- =====================================================================
