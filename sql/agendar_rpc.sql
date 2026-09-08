-- =====================================================================
-- CRIAR AGENDAMENTO DE FORMA ATOMICA — PARTE 3.2 (banco)
--
-- O problema que isto resolve:
--
-- Desde a Parte 2 o app faz DUAS escritas separadas — uma em
-- appointments, outra em appointment_services. Entre uma e outra pode
-- dar errado (queda de rede, erro do banco), e ai fica um agendamento
-- gravado sem a lista completa de servicos. Nao da para desfazer do
-- lado do cliente: nao existe (e nem deveria existir) politica de
-- DELETE para visitante em appointments.
--
-- A saida e mover as duas escritas para DENTRO do banco, numa funcao.
-- Toda funcao chamada pelo PostgREST roda dentro de UMA transacao: se
-- qualquer comando falhar no meio, tudo que ela fez ate ali e desfeito
-- automaticamente. Nao existe "meio gravado". Nao e preciso escrever
-- begin/commit aqui dentro — e justamente o contrario, nao se pode.
--
-- De quebra, a duracao passa a ser calculada no SERVIDOR. Hoje quem
-- somaria seria o navegador, e navegador e a parte do sistema que
-- qualquer pessoa consegue editar. Somando aqui, ninguem consegue
-- registrar um corte de 90 minutos dizendo que dura 5 para furar a
-- trava de sobreposicao.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
--
-- >>> AINDA NAO FOI EXECUTADO. Revise antes de rodar. <<<
-- E rode ANTES de subir a Parte 3.2 do frontend: o app novo chama esta
-- funcao, e sem ela no banco todo agendamento falha.
-- =====================================================================


-- #####################################################################
-- PASSO 0 — PRE-VOO (so leitura)
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0.1 — O terreno da 3.1 esta preparado?
--
-- Esperado:
--   duracao_min_existe        = 1
--   duracao_min_not_null      = 1
--   trava_sobreposicao_existe = 1
--
-- Se algum vier 0, a sub-parte 3.1 nao foi aplicada por inteiro. Pare.
-- ---------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments'
      and column_name = 'duracao_min')                        as duracao_min_existe,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments'
      and column_name = 'duracao_min' and is_nullable = 'NO') as duracao_min_not_null,
  (select count(*) from pg_constraint
    where conrelid = 'public.appointments'::regclass
      and contype = 'x')                                      as trava_sobreposicao_existe;


-- ---------------------------------------------------------------------
-- 0.2 — Quais colunas de appointments sao obrigatorias?
--
-- A funcao precisa preencher TODAS as que sao NOT NULL e nao tem
-- default. Se aparecer alguma que eu nao previ (algo como "criado_por"),
-- me avise antes de rodar — o insert falharia.
-- ---------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'appointments'
order by ordinal_position;


-- ---------------------------------------------------------------------
-- 0.3 — O visitante consegue mesmo fazer o que a funcao vai fazer?
--
-- A funcao roda com as permissoes de QUEM CHAMA (ver a nota de
-- seguranca no PASSO 1). Entao anon precisa ter:
--   - INSERT em appointments
--   - INSERT em appointment_services
--   - SELECT em services
--
-- Confira que aparecem essas tres linhas com anon no meio dos roles.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('appointments', 'appointment_services', 'services')
order by tablename, cmd, policyname;


-- #####################################################################
-- PASSO 1 — A FUNCAO
-- #####################################################################

-- ---------------------------------------------------------------------
-- SEGURANCA — por que SECURITY INVOKER e nao SECURITY DEFINER
--
-- SECURITY DEFINER faria a funcao rodar com os poderes do DONO dela
-- (postgres), ignorando o RLS por completo. E a opcao poderosa, e por
-- isso mesmo a errada aqui: nada do que esta funcao faz precisa de
-- poder extra. Tudo ja e permitido ao visitante pelas politicas que
-- existem hoje:
--
--   insert em appointments          -> politica de insert publico
--   insert em appointment_services  -> politica de insert publico
--   select em services              -> leitura publica (cardapio)
--
-- Com INVOKER, o RLS continua valendo dentro da funcao. Isso e uma rede
-- de seguranca de verdade: se um dia alguem acrescentar aqui um "select
-- from appointments", o RLS BLOQUEIA, porque visitante nao tem politica
-- de leitura. Com DEFINER, esse mesmo select passaria — e a funcao
-- viraria um vazamento de agenda alheia sem ninguem perceber.
--
-- Por que a funcao nao consegue ler agendamento de outra pessoa:
--   1. Ela nunca faz SELECT em appointments.
--   2. Ela devolve apenas um uuid que ela mesma sorteou, nunca uma
--      linha da tabela.
--   3. Mesmo que tentasse, o RLS recusaria (item acima).
--
-- Repare que os dois INSERT nao tem RETURNING. Isso e de proposito: sob
-- RLS, "insert ... returning" tambem exige politica de SELECT, e o
-- visitante nao tem. Por isso o id e sorteado ANTES, com
-- gen_random_uuid(), e usado explicitamente.
--
-- set search_path = '': mesmo com INVOKER, fixar o caminho impede que
-- alguem crie uma tabela chamada "services" em outro schema e faca a
-- funcao ler a tabela errada. Por isso todo objeto vai escrito com
-- "public." na frente.
--
-- (Funcoes internas como sum, count e unnest nao precisam de prefixo:
--  pg_catalog e sempre pesquisado, mesmo com search_path vazio.)
-- ---------------------------------------------------------------------

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
security invoker
set search_path = ''
as $$
declare
  -- Sorteado aqui para nao precisar de RETURNING (ver nota de seguranca).
  v_id            uuid := pg_catalog.gen_random_uuid();
  v_ids           uuid[];
  v_duracao_total integer;
  v_encontrados   integer;
begin
  -- -------------------------------------------------------------------
  -- 1. Validacoes de entrada
  --
  -- O app ja checa tudo isto na tela, mas a tela pode ser contornada:
  -- qualquer pessoa consegue chamar a funcao direto pela API. Validar
  -- aqui e o que realmente vale.
  -- -------------------------------------------------------------------
  if p_service_ids is null or pg_catalog.array_length(p_service_ids, 1) is null then
    raise exception 'Escolha pelo menos um servico.' using errcode = 'P0001';
  end if;

  if p_data_hora is null then
    raise exception 'Informe a data e o horario.' using errcode = 'P0001';
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
  -- quantidade (ver NOTA 2 do appointment_services.sql), "corte + corte"
  -- vira "corte" — que e o que o banco consegue representar.
  --
  -- A ordem se perde aqui, e tudo bem: ela so importa para a coluna
  -- antiga service_id, que usa p_service_ids[1], a lista original.
  -- -------------------------------------------------------------------
  select array_agg(distinct sid) into v_ids
  from unnest(p_service_ids) as sid;

  -- -------------------------------------------------------------------
  -- 3. Soma a duracao NO SERVIDOR
  --
  -- count(*) junto com sum() nao e detalhe: se um id nao existir, ou for
  -- de um servico que o visitante nao enxerga (inativo, se um dia o RLS
  -- filtrar por ativo), o sum simplesmente ignora e a duracao sai menor
  -- do que deveria — silenciosamente. Comparar a contagem transforma
  -- esse erro silencioso em erro alto.
  -- -------------------------------------------------------------------
  select coalesce(sum(s.duracao_min), 0), count(*)
    into v_duracao_total, v_encontrados
  from public.services s
  where s.id = any (v_ids);

  if v_encontrados <> pg_catalog.array_length(v_ids, 1) then
    raise exception 'Ha servico inexistente ou indisponivel na lista enviada.'
      using errcode = 'P0001';
  end if;

  -- Bate com o CHECK appointments_duracao_positiva da 3.1. Duracao zero
  -- produziria um intervalo vazio, que nao se sobrepoe a nada — o
  -- agendamento escaparia da trava.
  if v_duracao_total <= 0 then
    raise exception 'A duracao total do agendamento precisa ser maior que zero.'
      using errcode = 'P0001';
  end if;

  -- -------------------------------------------------------------------
  -- 4. O agendamento
  --
  -- E AQUI que a trava de sobreposicao da 3.1 e testada. Se o horario
  -- estiver ocupado, este insert levanta 23P01 e a funcao inteira e
  -- desfeita — inclusive o insert do passo 5, que nem chega a rodar.
  -- Nao capturamos esse erro de proposito: ele precisa chegar ao app.
  --
  -- service_id: coluna antiga, ainda obrigatoria. Recebe o primeiro da
  -- lista ORIGINAL. Sai quando a Parte 4 aposentar a coluna.
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
  -- 6. Devolve so o id
  --
  -- Nao devolvemos a linha inteira: montar isso exigiria ler
  -- appointments, e visitante nao pode. O app tambem nao precisa de
  -- mais nada — ele ja tem na tela tudo que vai mostrar.
  -- -------------------------------------------------------------------
  return v_id;
end;
$$;


comment on function public.criar_agendamento(uuid, timestamptz, text, text, uuid[]) is
  'Cria um agendamento e seus servicos numa unica transacao. A duracao e '
  'somada no servidor a partir de services.duracao_min, nunca recebida do '
  'cliente. Propaga 23P01 quando a trava de sobreposicao recusa o horario.';


-- ---------------------------------------------------------------------
-- PASSO 2 — QUEM PODE CHAMAR
--
-- Por padrao o Postgres da EXECUTE para PUBLIC em funcao nova. Preferimos
-- ser explicitos: tiramos de todo mundo e devolvemos so para os dois
-- papeis que existem no app. Assim, se amanha aparecer um papel novo,
-- ele nao ganha acesso de brinde.
--
-- anon          = o cliente agendando sem login (o caso principal)
-- authenticated = o dono logado, se um dia agendar pela area de gestao
-- ---------------------------------------------------------------------
revoke all on function public.criar_agendamento(uuid, timestamptz, text, text, uuid[])
  from public;

grant execute on function public.criar_agendamento(uuid, timestamptz, text, text, uuid[])
  to anon, authenticated;


-- ---------------------------------------------------------------------
-- PASSO 3 — AVISAR A API QUE A FUNCAO EXISTE
--
-- O PostgREST guarda um retrato do schema em memoria. No Supabase ele
-- costuma se atualizar sozinho, mas se a primeira chamada do app disser
-- "Could not find the function public.criar_agendamento", rode isto:
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';


-- =====================================================================
-- COMO O ERRO CHEGA NO FRONTEND
--
-- A funcao nao captura nada. Quando a trava dispara, o erro sobe puro,
-- o PostgREST o traduz e o supabase-js entrega assim:
--
--   const { data, error } = await supabase.rpc('criar_agendamento', {...})
--
--   HTTP 409
--   error.code    === '23P01'
--   error.message === 'conflicting key value violates exclusion
--                      constraint "appointments_sem_sobreposicao"'
--   data          === null
--
-- Ou seja: o codigo chega em error.code, no primeiro nivel — nao vem
-- aninhado. O que muda em relacao ao insert direto e so o CODIGO
-- (23P01 em vez de 23505), nao o formato.
--
-- As validacoes do passo 1 chegam como:
--   HTTP 400
--   error.code    === 'P0001'
--   error.message === o texto do raise (ex: 'Escolha pelo menos um servico.')
--
-- O app trata 23P01 e 23505 como "horario ocupado" e todo o resto como
-- falha generica. Nao mostramos error.message ao cliente: e texto
-- tecnico, em ingles, e pode expor nome de constraint.
-- =====================================================================


-- =====================================================================
-- VERIFICACOES — rode depois
-- =====================================================================

-- ---------------------------------------------------------------------
-- V1) A funcao existe, com a assinatura certa e como INVOKER?
--     seguranca deve ser 'invoker'. Se vier 'definer', algo saiu errado.
-- ---------------------------------------------------------------------
select
  p.proname                                        as nome,
  pg_get_function_identity_arguments(p.oid)        as parametros,
  pg_get_function_result(p.oid)                    as retorno,
  case when p.prosecdef then 'definer' else 'invoker' end as seguranca,
  p.proconfig                                      as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'criar_agendamento';


-- ---------------------------------------------------------------------
-- V2) Quem pode executar?
--     Devem aparecer anon e authenticated.
-- ---------------------------------------------------------------------
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'criar_agendamento'
order by grantee;


-- ---------------------------------------------------------------------
-- V3) TESTE COMPLETO — dentro de begin/rollback, nada fica gravado.
--
-- Rode o bloco INTEIRO. Leia assim:
--
--   1) primeira chamada  -> DEVE PASSAR e devolver um uuid
--   2) conferencia       -> DEVE mostrar a duracao somada e N servicos
--   3) segunda chamada   -> DEVE FALHAR com 23P01
--
-- Depois do erro em (3) a transacao aborta e o resto reclama de
-- "current transaction is aborted" — esperado. O rollback limpa tudo.
-- ---------------------------------------------------------------------
begin;

-- 1) Cria com DOIS servicos (Corte 40 + Barba 30 = 70 min, se forem
--    esses os dois primeiros do cardapio).
select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-03-01 09:00:00-03',
  'Teste RPC',
  '(21) 90000-0000',
  array(select id from public.services order by id limit 2)
) as id_criado;

-- 2) Confere o que foi gravado.
--    duracao_min tem que ser a SOMA, e qtd_servicos tem que ser 2.
select a.data_hora, a.duracao_min, a.cliente_nome,
       count(aps.service_id)                        as qtd_servicos,
       string_agg(s.nome, ' + ' order by s.nome)    as servicos
from public.appointments a
join public.appointment_services aps on aps.appointment_id = a.id
join public.services s                on s.id = aps.service_id
where a.cliente_nome = 'Teste RPC'
group by a.id, a.data_hora, a.duracao_min, a.cliente_nome;

-- 3) Mesmo barbeiro, 09:30 — cai dentro dos 70 min do primeiro.
--    DEVE FALHAR com 23P01.
select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-03-01 09:30:00-03',
  'Teste RPC conflito',
  '(21) 90000-0000',
  array(select id from public.services order by id limit 1)
);

rollback;


-- ---------------------------------------------------------------------
-- V4) A atomicidade funciona? (o ponto central desta sub-parte)
--
-- Passamos um uuid de servico que nao existe. O esperado e:
--   - erro P0001 'Ha servico inexistente ou indisponivel...'
--   - e NENHUMA linha criada em appointments
--
-- A segunda consulta tem que devolver 0. Se devolver 1, a funcao nao
-- esta atomica e precisamos revisar.
-- ---------------------------------------------------------------------
begin;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-03-02 09:00:00-03',
  'Teste atomicidade',
  '(21) 90000-0000',
  array['00000000-0000-0000-0000-000000000000'::uuid]
);

rollback;

-- Rode DEPOIS do rollback acima, fora da transacao. Deve dar 0.
select count(*) as nao_deve_ter_sobrado
from public.appointments
where cliente_nome = 'Teste atomicidade';


-- =====================================================================
-- NOTAS
--
-- (1) A trava de sobreposicao continua sendo a rede de seguranca, nao o
--     calculo de horarios. O app precisa parar de OFERECER horarios que
--     colidem, senao o cliente escolhe um horario que a funcao vai
--     recusar. Com as duracoes atuais (Corte 40, Corte + Barba 70,
--     Pezinho 15) e a grade de 30 em 30, isso acontece o tempo todo:
--     um Corte as 10:00 termina 10:40 e invalida o slot das 10:30, mas
--     o app ainda oferece 10:30. Isso e a sub-parte 3.3.
--
-- (2) O PRECO nao e carimbado, so a duracao. Entao, se o preco de
--     "Corte" mudar, o faturamento dos meses passados muda junto — a
--     mesma incoerencia historica que a duracao carimbada resolveu.
--     O conserto seria uma coluna appointments.preco_total preenchida
--     por esta funcao, mais um backfill. Nao foi feito porque nao
--     estava no escopo desta sub-parte.
--
-- (3) Depois que o app estiver usando so a rpc, a politica de INSERT
--     publico direto em appointments e appointment_services fica
--     desnecessaria: da para revoga-la e deixar a rpc como unica porta
--     de entrada. Isso impediria alguem de criar agendamento pela API
--     pulando as validacoes daqui. Boa candidata para a Parte 4.
-- =====================================================================
