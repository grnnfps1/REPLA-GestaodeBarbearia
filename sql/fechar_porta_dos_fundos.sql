-- =====================================================================
-- A RPC VIRA A UNICA PORTA DE ENTRADA — PARTE 4, PECA A (banco)
--
-- O problema:
--
-- appointments e appointment_services tem politica de INSERT publica.
-- Isso e o que permite a criar_agendamento (SECURITY INVOKER) gravar —
-- mas permite tambem que QUALQUER UM chame a API direto e insira,
-- pulando todas as validacoes da funcao: a duracao somada no servidor,
-- a checagem de servico inexistente, nome e telefone vazios.
--
-- Comprovado com uma sonda: um POST em /rest/v1/appointments com a
-- chave anon e um barber_id inexistente responde 23503 (violacao de
-- chave estrangeira), e NAO 42501 (RLS negou). Ou seja, o RLS deixou
-- passar; quem barrou foi a integridade referencial. Com ids validos, a
-- linha entraria.
--
-- A solucao: a funcao passa a gravar com poderes de dono (DEFINER) e as
-- politicas publicas sao removidas. Sobra uma porta so, e ela valida.
--
-- A ORDEM IMPORTA. Este arquivo troca a funcao ANTES de fechar as
-- politicas. Nos dois passos as portas ficam abertas, entao em nenhum
-- momento existe uma janela em que ninguem consegue agendar. Fazer ao
-- contrario derrubaria os agendamentos entre um comando e outro.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
--
-- >>> RODE O PASSO 0 PRIMEIRO E ME MANDE O RESULTADO. <<<
-- O PASSO 3 depende do nome exato das politicas, que so o pre-voo diz.
-- =====================================================================


-- #####################################################################
-- PASSO 0 — PRE-VOO (so leitura)
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0.1 — As politicas que vamos remover
--
-- Anote os NOMES das linhas com cmd = INSERT nas duas tabelas: sao
-- exatamente essas que o PASSO 3 derruba, e as mesmas que o rollback
-- recria. Guarde tambem a coluna with_check — e o que voce precisa para
-- recriar identica se algo der errado.
--
-- Em appointment_services o nome provavel e
-- "appointment_services_insert_publico" (veio do arquivo da Parte 1).
-- Em appointments eu nao sei, foi criada antes de mim.
--
-- Confira que NAO ha politica de UPDATE ou DELETE que vamos quebrar sem
-- querer: este arquivo nao mexe nelas, mas e bom saber o que existe.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('appointments', 'appointment_services')
order by tablename, cmd, policyname;


-- ---------------------------------------------------------------------
-- 0.2 — O ACHADO 1: o RLS de services filtra por 'ativo'?
--
-- Por que isso importa agora: hoje a funcao e INVOKER, entao a busca dos
-- servicos roda como o visitante e enxerga exatamente o que ele
-- enxerga. Virando DEFINER, ela passa por cima do RLS de services
-- tambem.
--
-- Se existir uma politica com algo como "using (ativo)", entao HOJE um
-- servico desativado ja reprova na checagem de contagem, e depois da
-- troca passaria a ser aceito — a mudanca abriria um buraco em silencio.
--
-- Olhe a coluna "qual" da politica de SELECT em services:
--   qual = true      -> o RLS nao filtra; nada muda com o DEFINER
--   qual = (ativo)   -> o RLS filtra; a troca mudaria o comportamento
--
-- Em qualquer um dos dois casos o PASSO 1 resolve, porque passa a exigir
-- s.ativo explicitamente dentro da funcao. Mas eu quero saber o estado
-- de onde estamos saindo — se for o segundo caso, existe a chance de
-- ja haver agendamento antigo com servico desativado.
-- ---------------------------------------------------------------------
select policyname, cmd, roles, qual
from pg_policies
where schemaname = 'public' and tablename = 'services'
order by cmd, policyname;

-- Complemento: quantos servicos estao desativados hoje? Se for 0, o
-- achado 1 e teorico e nao ha nada a corrigir no passado.
select count(*) filter (where ativo)     as ativos,
       count(*) filter (where not ativo) as desativados
from public.services;


-- ---------------------------------------------------------------------
-- 0.3 — A funcao existe e hoje e INVOKER?
--
-- Esperado:
--   seguranca = invoker
--   config    = {search_path=""}
--   dono      = postgres
--
-- O DONO e o que decide se o DEFINER vai funcionar: a funcao passara a
-- rodar com os poderes dele. Se vier algo diferente de postgres, me
-- avise antes de continuar.
-- ---------------------------------------------------------------------
select
  p.proname                                 as nome,
  pg_get_function_identity_arguments(p.oid) as parametros,
  case when p.prosecdef then 'definer' else 'invoker' end as seguranca,
  p.proconfig                               as config,
  pg_get_userbyid(p.proowner)               as dono
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'criar_agendamento';


-- ---------------------------------------------------------------------
-- 0.4 — O RLS esta ligado, e o dono escapa dele?
--
-- Esperado nas duas tabelas:
--   rls_ligado  = true   (por isso remover a politica ja basta)
--   rls_forcado = false  (por isso o dono consegue gravar)
--
-- Se rls_forcado vier true em alguma, o DEFINER nao resolve e o plano
-- muda — pare e me avise.
-- ---------------------------------------------------------------------
select
  c.relname                   as tabela,
  c.relrowsecurity            as rls_ligado,
  c.relforcerowsecurity       as rls_forcado,
  pg_get_userbyid(c.relowner) as dono
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('appointments', 'appointment_services')
order by c.relname;


-- #####################################################################
-- >>> PARE AQUI. Rode os quatro blocos e me mande o resultado. <<<
--
--   0.1 -> os nomes das politicas, para o PASSO 3 e para o rollback
--   0.2 -> se o achado 1 e real ou teorico
--   0.3 -> confirma o ponto de partida
--   0.4 -> confirma que o DEFINER resolve
-- #####################################################################




-- #####################################################################
-- PASSO 1 — A FUNCAO VIRA DEFINER
--
-- Passo REVERSIVEL e sem risco de indisponibilidade: as politicas
-- continuam de pe. Se algo sair errado aqui, basta recriar a funcao
-- como estava (o arquivo sql/agendar_rpc.sql tem a versao anterior).
--
-- "create or replace" preserva o DONO e os GRANTs existentes, entao o
-- "grant execute to anon, authenticated" continua valendo. O PASSO 4
-- confere.
-- #####################################################################

create or replace function public.criar_agendamento(
  p_barber_id        uuid,
  p_data_hora        timestamptz,
  p_cliente_nome     text,
  p_cliente_telefone text,
  p_service_ids      uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id            uuid := pg_catalog.gen_random_uuid();
  v_ids           uuid[];
  v_duracao_total integer;
  v_encontrados   integer;
begin
  -- ===================================================================
  -- DISCIPLINA QUE O SECURITY DEFINER EXIGE — leia antes de editar
  --
  -- Esta funcao roda com os poderes do DONO da tabela, nao com os de
  -- quem chama. O RLS nao a barra. Isso e proposital: sem esse poder
  -- ela nao consegue gravar depois que as politicas publicas de INSERT
  -- foram removidas, e sao elas que fechavam a porta dos fundos.
  --
  -- Em troca, duas regras. Nao sao estilo, sao a seguranca do sistema:
  --
  --   1. ESTA FUNCAO NAO LE appointments. Nenhum select, nenhum
  --      "returning". Ela so escreve. Rodando como dono, um select aqui
  --      NAO seria barrado pelo RLS — seria a agenda de terceiros
  --      saindo por uma funcao que o visitante pode chamar.
  --
  --   2. O RETORNO CONTINUA SENDO uuid. Trocar por "returns table" ou
  --      devolver a linha criada abre a porta para o item 1 sem parecer
  --      que abriu.
  --
  -- Mudar qualquer uma das duas deixa de ser ajuste e vira decisao de
  -- seguranca. Se precisar mesmo, o caminho correto e outro: criar um
  -- papel dedicado com privilegio minimo e passar a funcao para ele,
  -- em vez de deixa-la como dono da tabela.
  -- ===================================================================

  -- -------------------------------------------------------------------
  -- 1. Validacoes de entrada
  --
  -- Isto deixou de ser cinto de seguranca e virou A regra. Antes, quem
  -- quisesse burlar inseria direto na API; agora esta e a unica entrada,
  -- entao o que nao for checado aqui simplesmente nao e checado.
  -- -------------------------------------------------------------------
  if p_service_ids is null or pg_catalog.array_length(p_service_ids, 1) is null then
    raise exception 'Escolha pelo menos um servico.' using errcode = 'P0001';
  end if;

  if p_data_hora is null then
    raise exception 'Informe a data e o horario.' using errcode = 'P0001';
  end if;

  -- NOVO — nao deixa agendar no passado.
  --
  -- Sobre o fuso: nao ha conversao a fazer aqui, e isso e de proposito.
  -- p_data_hora e now() sao os dois timestamptz, ou seja, INSTANTES
  -- absolutos. Comparar dois instantes independe de fuso — "10:00-03:00"
  -- e "13:00+00:00" sao o mesmo momento e o Postgres sabe disso. O
  -- -03:00 fixo do resto do sistema serve para converter entre relogio
  -- de parede e instante (e o que a horarios_ocupados faz ao recortar um
  -- dia). Aqui nao existe relogio de parede envolvido; enfiar uma
  -- conversao so criaria chance de errar.
  --
  -- A tolerancia de 2 minutos cobre um caso real: o cliente escolhe o
  -- horario num passo e confirma no seguinte, entao a virada pode cair
  -- no meio do preenchimento. Recusar por 40 segundos de atraso seria
  -- hostil sem motivo; recusar ontem, nao.
  if p_data_hora < pg_catalog.now() - interval '2 minutes' then
    raise exception 'Nao e possivel agendar em uma data/horario que ja passou.'
      using errcode = 'P0001';
  end if;

  if p_cliente_nome is null or pg_catalog.btrim(p_cliente_nome) = '' then
    raise exception 'Informe o nome do cliente.' using errcode = 'P0001';
  end if;

  if p_cliente_telefone is null or pg_catalog.btrim(p_cliente_telefone) = '' then
    raise exception 'Informe o telefone do cliente.' using errcode = 'P0001';
  end if;

  -- -------------------------------------------------------------------
  -- 2. Tira repetidos da lista
  --
  -- appointment_services tem chave primaria (appointment_id,
  -- service_id): o mesmo servico duas vezes daria erro de duplicata e
  -- derrubaria o agendamento inteiro. Como o modelo nao suporta
  -- quantidade, "corte + corte" vira "corte".
  --
  -- A ordem se perde aqui, e tudo bem: ela so importa para a coluna
  -- antiga service_id, que usa p_service_ids[1], a lista original.
  -- -------------------------------------------------------------------
  select array_agg(distinct sid) into v_ids
  from unnest(p_service_ids) as sid;

  -- -------------------------------------------------------------------
  -- 3. Soma a duracao NO SERVIDOR
  --
  -- NOVO — o "and s.ativo".
  --
  -- Rodando como INVOKER, a funcao enxergava services pelos olhos do
  -- visitante, entao o filtro de ativo vinha de graca SE o RLS
  -- filtrasse. Como DEFINER ela ve tudo, e essa protecao acidental
  -- sumiria: daria para agendar um servico tirado do cardapio.
  --
  -- Deixar explicito e melhor de qualquer forma. A porta unica declara
  -- as proprias regras em vez de herda-las por acaso de outro lugar.
  --
  -- count(*) junto com sum() nao e detalhe: se um id nao existir, ou
  -- estiver desativado, o sum simplesmente ignora e a duracao sai menor
  -- do que deveria — silenciosamente. Comparar a contagem transforma
  -- esse erro silencioso em erro alto.
  -- -------------------------------------------------------------------
  select coalesce(sum(s.duracao_min), 0), count(*)
    into v_duracao_total, v_encontrados
  from public.services s
  where s.id = any (v_ids)
    and s.ativo;

  if v_encontrados <> pg_catalog.array_length(v_ids, 1) then
    raise exception 'Ha servico inexistente ou indisponivel na lista enviada.'
      using errcode = 'P0001';
  end if;

  -- Bate com o CHECK appointments_duracao_positiva. Duracao zero
  -- produziria um intervalo vazio, que nao se sobrepoe a nada — o
  -- agendamento escaparia da trava.
  if v_duracao_total <= 0 then
    raise exception 'A duracao total do agendamento precisa ser maior que zero.'
      using errcode = 'P0001';
  end if;

  -- -------------------------------------------------------------------
  -- 4. O agendamento
  --
  -- E AQUI que a trava de sobreposicao e testada. Se o horario estiver
  -- ocupado, este insert levanta 23P01 e a funcao inteira e desfeita —
  -- inclusive o insert do passo 5, que nem chega a rodar. Nao
  -- capturamos esse erro de proposito: ele precisa chegar ao app.
  --
  -- Sem "returning", por disciplina (regra 1 la em cima) e porque o id
  -- ja veio do gen_random_uuid().
  --
  -- service_id: coluna antiga, ainda obrigatoria. Recebe o primeiro da
  -- lista ORIGINAL. Sai quando a Peca B aposentar a coluna.
  -- -------------------------------------------------------------------
  insert into public.appointments
    (id, barber_id, service_id, data_hora, duracao_min,
     cliente_nome, cliente_telefone, status)
  values
    (v_id, p_barber_id, p_service_ids[1], p_data_hora, v_duracao_total,
     pg_catalog.btrim(p_cliente_nome), pg_catalog.btrim(p_cliente_telefone),
     'confirmado');

  -- -------------------------------------------------------------------
  -- 5. Os servicos
  -- -------------------------------------------------------------------
  insert into public.appointment_services (appointment_id, service_id)
  select v_id, sid from unnest(v_ids) as sid;

  -- -------------------------------------------------------------------
  -- 6. Devolve so o id (regra 2 la em cima)
  -- -------------------------------------------------------------------
  return v_id;
end;
$$;


comment on function public.criar_agendamento(uuid, timestamptz, text, text, uuid[]) is
  'UNICA porta de entrada para criar agendamento. SECURITY DEFINER: as '
  'politicas de INSERT publico foram removidas, entao ela grava com poderes '
  'de dono. NAO le appointments e devolve apenas uuid — mudar isso e decisao '
  'de seguranca, nao ajuste. Soma a duracao no servidor, exige servico ativo '
  'e recusa data no passado. Propaga 23P01 quando o horario ja esta ocupado.';


-- ---------------------------------------------------------------------
-- Avisa a API. O corpo mudou, entao vale garantir.
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';


-- #####################################################################
-- PASSO 2 — TESTE INTERMEDIARIO (as portas ainda estao abertas)
--
-- Este e o momento de descobrir problema. Se algo aqui falhar, nada foi
-- fechado ainda e o app segue funcionando normalmente.
-- #####################################################################

-- ---------------------------------------------------------------------
-- 2.1 — A funcao virou DEFINER e manteve dono, config e permissoes?
--
-- Esperado: seguranca = definer, config = {search_path=""},
-- dono = postgres, e anon + authenticated com EXECUTE.
-- ---------------------------------------------------------------------
select
  case when p.prosecdef then 'definer' else 'invoker' end as seguranca,
  p.proconfig                 as config,
  pg_get_userbyid(p.proowner) as dono
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'criar_agendamento';

select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'criar_agendamento'
order by grantee;


-- ---------------------------------------------------------------------
-- 2.2 — Grava certo, chamada como VISITANTE?
--
-- "set local role anon" faz a sessao fingir ser o visitante, entao isto
-- testa o mesmo caminho do app: permissao de EXECUTE + gravacao via
-- DEFINER. Tudo em begin/rollback, nada fica.
--
-- Esperado: devolve um uuid, e a conferencia mostra a duracao SOMADA e
-- a quantidade certa de servicos.
-- ---------------------------------------------------------------------
begin;
set local role anon;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-06-01 09:00:00-03',
  'Teste DEFINER',
  '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 2)
) as id_criado;

-- volta a ser postgres so para conseguir LER e conferir
-- (o visitante nao pode ler appointments, e e isso que queremos)
reset role;

select a.data_hora, a.duracao_min, a.cliente_nome,
       count(aps.service_id)                     as qtd_servicos,
       string_agg(s.nome, ' + ' order by s.nome) as servicos
from public.appointments a
join public.appointment_services aps on aps.appointment_id = a.id
join public.services s                on s.id = aps.service_id
where a.cliente_nome = 'Teste DEFINER'
group by a.id, a.data_hora, a.duracao_min, a.cliente_nome;

rollback;


-- ---------------------------------------------------------------------
-- 2.3 — A validacao de data no passado funciona?
--
-- DEVE FALHAR com P0001 'Nao e possivel agendar em uma data/horario que
-- ja passou.'
-- ---------------------------------------------------------------------
begin;
select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  pg_catalog.now() - interval '1 day',
  'Teste passado',
  '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
);
rollback;


-- ---------------------------------------------------------------------
-- 2.4 — O "and s.ativo" funciona?
--
-- Desativa um servico temporariamente, tenta agendar com ele e desfaz.
-- DEVE FALHAR com P0001 'Ha servico inexistente ou indisponivel...'
--
-- Se PASSAR, o filtro nao esta pegando — me avise antes do PASSO 3.
-- ---------------------------------------------------------------------
begin;

update public.services
set ativo = false
where id = (select id from public.services order by id limit 1);

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-06-02 09:00:00-03',
  'Teste inativo',
  '(21) 90000-0000',
  array(select id from public.services order by id limit 1)
);

rollback;


-- ---------------------------------------------------------------------
-- 2.5 — E O TESTE QUE MAIS IMPORTA: o app de verdade.
--
-- Os blocos acima rodam no banco. Este roda pelo caminho real.
--
--   1. Abra o site numa JANELA ANONIMA (sem login).
--   2. Agende normalmente, com 2 servicos.
--   3. Confira na area de gestao que o agendamento apareceu, com o
--      intervalo certo ("10:00 / ate 11:10") e o valor somado.
--
-- So siga para o PASSO 3 depois que isto funcionar. E o unico jeito de
-- saber que a troca para DEFINER nao quebrou nada no caminho real,
-- enquanto ainda da para voltar atras sem pressa.
-- ---------------------------------------------------------------------


-- #####################################################################
-- PASSO 3 — FECHAR A PORTA DOS FUNDOS
--
-- Agora sim. Depois destes dois comandos, inserir direto na API deixa
-- de ser possivel: com o RLS ligado e nenhuma politica de INSERT, o
-- Postgres nega. A funcao continua gravando porque roda como dono.
-- #####################################################################

-- ---------------------------------------------------------------------
-- >>> AJUSTE ANTES DE RODAR <<<
-- Troque os nomes abaixo pelos que apareceram no 0.1. O de
-- appointment_services veio do arquivo da Parte 1 e deve estar certo; o
-- de appointments e um chute e provavelmente NAO esta.
--
-- Por que "drop policy" e nao "revoke insert on table":
--
-- Sao dois mecanismos diferentes e sobrepor os dois deixa o sistema mais
-- dificil de entender depois. Sem politica, o RLS ja nega — e "nenhuma
-- politica = ninguem insere" e o modelo mental padrao do Supabase,
-- visivel na propria interface. Revogar tambem o GRANT criaria um
-- segundo bloqueio invisivel, e daqui a seis meses uma politica nova
-- que "nao funciona" custaria uma tarde para ser entendida.
-- ---------------------------------------------------------------------

drop policy if exists "appointments_insert_publico"
  on public.appointments;

drop policy if exists "appointment_services_insert_publico"
  on public.appointment_services;


-- ---------------------------------------------------------------------
-- ROLLBACK — se algo der errado, e isto que devolve tudo
--
-- Nao rode agora. Guarde. Recriar a politica reabre a porta e volta ao
-- comportamento de antes, em um comando por tabela.
--
-- IMPORTANTE: confira o "with_check" que voce anotou no 0.1 e use o
-- mesmo. Se la estava algo diferente de "true", ajuste — recriar mais
-- permissiva do que era seria trocar um problema por outro.
--
--   create policy "appointments_insert_publico"
--     on public.appointments for insert
--     to anon, authenticated
--     with check (true);
--
--   create policy "appointment_services_insert_publico"
--     on public.appointment_services for insert
--     to anon, authenticated
--     with check (true);
--
-- Se o problema for na funcao e nao nas politicas, o outro caminho de
-- volta e recriar a versao INVOKER que esta em sql/agendar_rpc.sql.
-- Mas atencao: a versao INVOKER so funciona COM as politicas de pe,
-- entao rode o rollback das politicas primeiro.
-- ---------------------------------------------------------------------


-- =====================================================================
-- PASSO 4 — VERIFICACAO FINAL (o teste de aceitacao)
-- =====================================================================

-- ---------------------------------------------------------------------
-- V1) Nao sobrou politica de INSERT nas duas tabelas?
--     DEVE retornar ZERO linhas.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('appointments', 'appointment_services')
  and cmd = 'INSERT';


-- ---------------------------------------------------------------------
-- V2) O visitante ainda consegue inserir direto? DEVE FALHAR.
--
-- Mesma ideia da sonda que provou a brecha, agora do lado de dentro do
-- banco. Esperado: erro 42501, "new row violates row-level security
-- policy for table appointments".
--
-- Se PASSAR (ou falhar com 23503, que e erro de chave estrangeira e
-- significa que o RLS deixou passar), a porta continua aberta.
-- ---------------------------------------------------------------------
begin;
set local role anon;

insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min,
   cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-07-01 10:00:00-03', 30,
   'Sonda porta dos fundos', '(21) 90000-0000', 'confirmado');

rollback;


-- ---------------------------------------------------------------------
-- V3) E o agendamento normal, continua funcionando? DEVE PASSAR.
--
-- O contraste com o V2 e o resultado desta peca inteira: a mesma
-- sessao, o mesmo papel anon, insercao direta NEGADA e insercao pela
-- funcao PERMITIDA.
-- ---------------------------------------------------------------------
begin;
set local role anon;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-07-02 09:00:00-03',
  'Teste porta unica',
  '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 2)
) as id_criado;

rollback;


-- ---------------------------------------------------------------------
-- V4) A sonda de fora, pela API — o teste que provou a brecha
--
-- Isto nao roda no SQL Editor: e um comando de terminal, com a chave
-- anon, batendo na API como qualquer pessoa da internet bateria. E a
-- prova de que a porta fechou de verdade, e nao so em teoria.
--
-- Me avise quando terminar o PASSO 3 que eu rodo daqui, do mesmo jeito
-- que rodei para provar a brecha. Se preferir rodar voce:
--
--   curl -s -X POST \
--     -H "apikey: SUA_ANON_KEY" \
--     -H "Authorization: Bearer SUA_ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"barber_id":"00000000-0000-0000-0000-000000000000",
--          "service_id":"00000000-0000-0000-0000-000000000000",
--          "data_hora":"2099-12-31T10:00:00-03:00",
--          "cliente_nome":"sonda","cliente_telefone":"0",
--          "status":"confirmado"}' \
--     "SUA_URL/rest/v1/appointments"
--
-- ANTES (a brecha):  {"code":"23503", ...}   HTTP 409
-- DEPOIS (fechada):  {"code":"42501", ...}   HTTP 403
--
-- O barber_id invalido de proposito garante que, mesmo que algo saia
-- errado e o RLS deixe passar, nenhuma linha e criada — a chave
-- estrangeira barra. A sonda nunca suja o banco.
-- =====================================================================


-- =====================================================================
-- NOTAS
--
-- (1) O editor de tabelas do Supabase continua funcionando normalmente.
--     Ele nao passa por anon nem por authenticated, entao voce nao
--     perde a capacidade de criar ou corrigir agendamento na mao.
--
-- (2) O que a funcao AINDA nao valida, agora que e a unica porta:
--       - horario fora da jornada (agendar as 3h da manha)
--       - dia fechado (domingo, segunda)
--       - se o barbeiro faz mesmo aqueles servicos
--     Nao incluí porque essas regras moram hoje so no App.jsx
--     (HORARIO_FUNCIONAMENTO) e duplica-las no banco criaria duas
--     verdades que vao divergir. O lugar certo delas e a tabela
--     working_hours prevista no CLAUDE.md; quando ela existir, a
--     validacao vem para ca.
--
-- (3) Nao ha politica de UPDATE nem de DELETE em appointments, e o app
--     nao tem tela de cancelar. Ou seja, "cancelado" hoje so se
--     consegue pela mao no Supabase — e a regra da trava que libera a
--     vaga ao cancelar esta escrita mas inalcancavel pela interface.
--     Candidata natural a uma proxima peca.
--
-- (4) Se um dia isto virar multi-tenant, a Opcao 3 que discutimos passa
--     a valer a pena: um papel dedicado com privilegio minimo como dono
--     da funcao, em vez do postgres. Ai um vazamento cruzaria fronteira
--     entre clientes diferentes, e o rigor extra se paga.
-- =====================================================================
