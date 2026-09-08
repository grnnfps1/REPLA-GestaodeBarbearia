-- =====================================================================
-- CANCELAR AGENDAMENTO — PARTE 1 (banco)
--
-- Cancelar aqui e "soft delete": a linha NAO some, o status vira
-- 'cancelado'. Duas coisas boas acontecem de graca, porque ja foram
-- construidas antes:
--
--   1. O historico fica. O dono continua vendo que aquele horario
--      existiu e foi desmarcado, em vez de a linha evaporar.
--   2. O horario volta a ficar livre NA HORA, sem mais nenhum codigo.
--      A trava appointments_sem_sobreposicao e parcial, com "where
--      status is distinct from 'cancelado'": cancelado sai do indice e
--      deixa de ocupar. A funcao horarios_ocupados filtra igual, entao
--      o app tambem para de mostrar o horario como tomado.
--
-- Falta uma coisa so: hoje NINGUEM consegue fazer UPDATE em
-- appointments pelo app. Nao ha politica de UPDATE — de proposito, ate
-- agora nao havia motivo. Este arquivo abre essa porta, do tamanho
-- exato do necessario.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
--
-- >>> AINDA NAO FOI EXECUTADO. Revise antes de rodar. <<<
-- =====================================================================


-- #####################################################################
-- PASSO 0 — PRE-VOO (so leitura)
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0.1 — Como estao as politicas de appointments hoje?
--
-- Esperado: NENHUMA linha com cmd = UPDATE. Se aparecer alguma, alguem
-- ja abriu essa porta antes e precisamos olhar juntos o que ela permite.
--
-- Esperado tambem: nenhuma linha com cmd = INSERT (a Peca A derrubou) e
-- uma de SELECT para authenticated.
-- ---------------------------------------------------------------------
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'appointments'
order by cmd, policyname;


-- ---------------------------------------------------------------------
-- 0.2 — Quais valores de status existem, e ha CHECK sobre eles?
--
-- Preciso saber antes de sugerir a lista fechada do PASSO 3 (opcional).
-- Se so existirem 'confirmado' e 'cancelado', a lista e segura. Se
-- houver outros ('pendente', 'concluido'...), o PASSO 3 sai de cena.
-- ---------------------------------------------------------------------
select status, count(*) as quantos
from public.appointments
group by status
order by quantos desc;

select conname as nome, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid = 'public.appointments'::regclass
  and contype = 'c'
order by conname;


-- ---------------------------------------------------------------------
-- 0.3 — Quem tem privilegio de UPDATE hoje?  << O ACHADO >>
--
-- Sonda feita de fora, antes de escrever este arquivo: um PATCH em
-- /rest/v1/appointments com a chave anon respondeu HTTP 204 No Content,
-- sem erro nenhum.
--
-- Isso quer dizer que anon TEM privilegio de UPDATE na tabela. O que
-- impede a atualizacao hoje e so o RLS — e RLS, no UPDATE, funciona
-- diferente do INSERT:
--
--   INSERT sem politica -> ERRO 42501, alto e claro.
--   UPDATE sem politica -> o USING nao casa com nenhuma linha, entao
--                          zero linhas mudam e NAO HA ERRO.
--
-- Ou seja, hoje o anon falha em silencio. Funciona, mas e o tipo de
-- protecao que some sem avisar: basta alguem criar uma politica de
-- UPDATE um pouco mais larga do que pretendia, e o anon comeca a
-- escrever sem que nada reclame em lugar nenhum.
--
-- Por isso o PASSO 1 revoga o privilegio de anon explicitamente: falhar
-- alto e melhor do que falhar quieto.
--
-- Rode os dois blocos e me mande. O primeiro mostra privilegio no nivel
-- da TABELA; o segundo, no nivel de COLUNA (hoje provavelmente vazio).
-- ---------------------------------------------------------------------
select grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'appointments'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;

select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'appointments'
  and privilege_type = 'UPDATE'
  and grantee in ('anon', 'authenticated')
order by grantee, column_name;


-- #####################################################################
-- >>> PARE AQUI. Rode o PASSO 0 e me mande o resultado. <<<
--
--   0.1 -> confirma que nao ha politica de UPDATE
--   0.2 -> decide se o PASSO 3 (opcional) faz sentido
--   0.3 -> confirma o achado do UPDATE silencioso
-- #####################################################################




-- #####################################################################
-- PASSO 1 — PRIVILEGIO DE COLUNA
--
-- A RESPOSTA A SUA PERGUNTA: sim, vale restringir por coluna. Recomendo.
--
-- O argumento nao e "seguranca em geral", e uma coisa concreta:
-- "authenticated" NAO quer dizer "o Gabriel". Quer dizer "qualquer
-- pessoa com conta neste projeto Supabase". Hoje e uma pessoa so, mas o
-- CLAUDE.md ja prevê DOIS papeis — Dono e Barbeiro, com o barbeiro
-- logando para ver a propria agenda. No dia em que o primeiro barbeiro
-- ganhar login, uma politica de UPDATE ampla deixa ele reescrever
-- data_hora, nome e telefone de QUALQUER agendamento, inclusive dos
-- outros barbeiros, sem deixar rastro. Isso nao e hipotese distante, e
-- o proximo passo previsto do produto.
--
-- O custo de evitar isso sao as duas linhas abaixo. Barato demais para
-- nao fazer.
--
-- Beneficio de brinde: protege contra um erro nosso. Se um dia o app
-- fizer .update({...agendamentoInteiro}) por descuido, o banco recusa
-- em vez de sobrescrever tudo.
--
-- E quando voce quiser reagendar pela tela (mudar data_hora)? Ai se
-- acrescenta data_hora ao grant, num comando. Ter que fazer isso de
-- proposito e a ideia, nao o incomodo.
--
--
-- "MAS VOCE NAO DISSE O CONTRARIO NA PECA A?"
--
-- Disse, e a diferenca importa. La eu recusei revogar o GRANT de INSERT
-- porque derrubar a politica JA RESOLVIA, e somar um segundo mecanismo
-- invisivel so dificultaria depurar depois.
--
-- Aqui o grant nao e redundante: e a UNICA ferramenta que existe. RLS
-- enxerga linhas, nao colunas — nao ha como escrever "so pode mudar o
-- status" numa politica. E o revoke do anon nao duplica nada: ele
-- transforma uma falha silenciosa numa falha alta, coisa que politica
-- nenhuma faz.
-- #####################################################################

-- ---------------------------------------------------------------------
-- 1.1 — Tira o UPDATE amplo dos dois papeis.
--
-- Depois disto o anon passa a levar 42501 ao tentar UPDATE, em vez de
-- um 204 vazio. E o authenticated fica temporariamente sem poder
-- atualizar nada — o que nao quebra coisa alguma, porque hoje o app
-- nao atualiza appointments em lugar nenhum (conferido no App.jsx: as
-- unicas escritas sao em portfolio_items).
-- ---------------------------------------------------------------------
revoke update on public.appointments from anon;
revoke update on public.appointments from authenticated;


-- ---------------------------------------------------------------------
-- 1.2 — Devolve o UPDATE, mas so da coluna status, e so ao logado.
--
-- Note que nao ha grant para anon. Nenhum. O visitante nao atualiza
-- coluna nenhuma, por nenhum caminho.
-- ---------------------------------------------------------------------
grant update (status) on public.appointments to authenticated;


-- #####################################################################
-- PASSO 2 — A POLITICA DE UPDATE
--
-- Privilegio e politica sao duas perguntas diferentes, e as duas
-- precisam de resposta:
--
--   grant  -> "voce pode mexer NESSA COLUNA?"   (PASSO 1)
--   policy -> "voce pode mexer NESSA LINHA?"    (aqui)
--
-- Sem a politica, o authenticated tem o grant mas o USING nao casa com
-- linha nenhuma, e o cancelamento falharia em silencio — exatamente o
-- que descrevi no 0.3.
--
-- "using (true)": qualquer linha. Numa barbearia so, o dono cancela o
-- que quiser. Quando o papel Barbeiro existir, esta e a linha que muda,
-- para algo como "o barbeiro so cancela os proprios" — e ela ja esta
-- isolada e pronta para isso.
--
-- Sem "with check": no UPDATE, quando o with check e omitido, o Postgres
-- usa a expressao do using para validar a linha nova tambem. Como e
-- true, qualquer resultado passa. Ver o PASSO 3 se quiser fechar os
-- valores de status.
--
-- "to authenticated" e o que responde ao seu requisito: anon nao entra.
-- #####################################################################

drop policy if exists "appointments_update_autenticado" on public.appointments;

create policy "appointments_update_autenticado"
  on public.appointments for update
  to authenticated
  using (true);


-- #####################################################################
-- PASSO 3 — (OPCIONAL) FECHAR OS VALORES DE STATUS
--
-- >>> SO RODE SE O 0.2 MOSTROU APENAS 'confirmado' E 'cancelado'. <<<
-- Se houver outros valores gravados, este comando FALHA (e com razao:
-- ele valida as linhas existentes) e a ideia sai de cena.
--
-- O que resolve: com o grant de coluna, a unica coisa que o logado pode
-- escrever e o status — mas pode escrever QUALQUER TEXTO nele. Um
-- 'cancelaod' com erro de digitacao viraria um agendamento que, para a
-- trava, continua ocupando o horario (porque e "distinct from
-- 'cancelado'"), e que na tela aparece com o selo de pendente. Erro
-- chato de achar.
--
-- Por que um CHECK e nao um "with check" na politica: o CHECK vale para
-- TODO MUNDO que escreve — a funcao criar_agendamento, o editor de
-- tabelas do Supabase, um script futuro. E da uma mensagem de erro
-- clara. Uma regra de dominio como esta pertence a tabela, nao a uma
-- politica de acesso.
-- #####################################################################

alter table public.appointments
  drop constraint if exists appointments_status_valido;

alter table public.appointments
  add constraint appointments_status_valido
  check (status in ('confirmado', 'cancelado'));


-- =====================================================================
-- SOBRE "DESCANCELAR" — voce perguntou se precisa impedir
--
-- Nao precisa, e por um motivo bom: o banco JA impede o caso perigoso,
-- sem uma linha a mais.
--
-- O cenario ruim seria: cancelo as 10:00 de terca, outro cliente pega
-- esse horario, e alguem "descancela" o primeiro — dois agendamentos no
-- mesmo lugar.
--
-- Nao acontece. A trava e um indice PARCIAL: ao voltar o status para
-- 'confirmado', a linha e REINSERIDA no indice, e se o horario ja tiver
-- dono ela bate com o outro e o UPDATE falha com 23P01. O banco recusa
-- sozinho.
--
-- E se o horario continuar livre, descancelar e inofensivo — ate util,
-- para desfazer um clique errado.
--
-- Somem-se a isso duas coisas: nao ha tela que descancele, e o app so
-- escreve 'cancelado'. Nao vou adicionar defesa para um caminho que o
-- banco ja fecha e que a interface nem oferece.
-- =====================================================================


-- =====================================================================
-- VERIFICACOES — rode depois
-- =====================================================================

-- ---------------------------------------------------------------------
-- V1) A politica existe e e so para authenticated?
--     Uma linha, cmd = UPDATE, roles = {authenticated}.
-- ---------------------------------------------------------------------
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'appointments' and cmd = 'UPDATE';


-- ---------------------------------------------------------------------
-- V2) O privilegio ficou so na coluna status?
--     A primeira consulta NAO deve mais listar UPDATE para anon nem
--     para authenticated. A segunda deve mostrar authenticated + status,
--     e nada de anon.
-- ---------------------------------------------------------------------
select grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'appointments'
  and privilege_type = 'UPDATE'
  and grantee in ('anon', 'authenticated');

select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'appointments'
  and privilege_type = 'UPDATE'
  and grantee in ('anon', 'authenticated')
order by grantee, column_name;


-- ---------------------------------------------------------------------
-- V3) O LOGADO consegue cancelar? DEVE PASSAR.
--
-- Cria um agendamento em 2099, cancela e confere. Tudo em
-- begin/rollback: nada fica.
-- ---------------------------------------------------------------------
begin;
set local role authenticated;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-09-01 10:00:00-03',
  'Teste cancelar',
  '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
);

update public.appointments
set status = 'cancelado'
where cliente_nome = 'Teste cancelar';

-- DEVE mostrar uma linha com status = cancelado
select cliente_nome, data_hora, status
from public.appointments
where cliente_nome = 'Teste cancelar';

rollback;


-- ---------------------------------------------------------------------
-- V4) O logado consegue mexer em OUTRA coluna? DEVE FALHAR.
--
-- Esperado: 42501, "permission denied for ... appointments" (a mensagem
-- exata varia com a versao, mas o codigo e 42501).
--
-- Se PASSAR, o grant de coluna nao pegou — volte ao PASSO 1.
--
-- Repare que nem precisa existir linha: o Postgres checa privilegio ao
-- montar o plano, nao linha a linha.
-- ---------------------------------------------------------------------
begin;
set local role authenticated;

update public.appointments
set cliente_nome = 'nao deveria conseguir'
where cliente_nome = 'qualquer coisa';

rollback;


-- ---------------------------------------------------------------------
-- V5) O VISITANTE consegue? DEVE FALHAR — e agora falha ALTO.
--
-- Esperado: 42501 permission denied.
--
-- Antes desta peca isto respondia "0 linhas atualizadas" sem erro
-- nenhum. Se voltar a nao dar erro, o revoke do 1.1 nao pegou.
-- ---------------------------------------------------------------------
begin;
set local role anon;

update public.appointments
set status = 'cancelado'
where cliente_nome = 'qualquer coisa';

rollback;


-- ---------------------------------------------------------------------
-- V6) Cancelar LIBERA o horario de verdade?
--
-- Dois blocos, e o contraste entre eles e a funcionalidade inteira.
--
-- V6a: sem cancelar, o segundo agendamento no mesmo horario DEVE FALHAR
--      com 23P01. (Prova que o horario estava mesmo ocupado.)
-- ---------------------------------------------------------------------
begin;
set local role authenticated;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-09-02 10:00:00-03',
  'Ocupa A', '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
);

-- DEVE FALHAR com 23P01
select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-09-02 10:00:00-03',
  'Ocupa B', '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
);

rollback;


-- ---------------------------------------------------------------------
-- V6b: cancelando o primeiro, o segundo DEVE PASSAR.
-- ---------------------------------------------------------------------
begin;
set local role authenticated;

select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-09-02 10:00:00-03',
  'Ocupa A', '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
);

update public.appointments
set status = 'cancelado'
where cliente_nome = 'Ocupa A';

-- Agora DEVE PASSAR: a vaga abriu
select public.criar_agendamento(
  (select id from public.barbers order by id limit 1),
  timestamptz '2099-09-02 10:00:00-03',
  'Ocupa B', '(21) 90000-0000',
  array(select id from public.services where ativo order by id limit 1)
) as id_do_segundo;

rollback;


-- ---------------------------------------------------------------------
-- V7) A sonda de fora, pela API
--
-- Nao roda no SQL Editor. Me avise quando terminar que eu rodo daqui,
-- como fiz nas outras pecas. Se quiser rodar voce:
--
--   curl -s -D - -X PATCH \
--     -H "apikey: SUA_ANON_KEY" \
--     -H "Authorization: Bearer SUA_ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"status":"cancelado"}' \
--     "SUA_URL/rest/v1/appointments?id=eq.00000000-0000-0000-0000-000000000000"
--
--   ANTES:  HTTP 204 No Content        (falha em silencio)
--   DEPOIS: HTTP 403 {"code":"42501"}  (falha alto)
--
-- O id inexistente garante que a sonda nunca altera nada de verdade.
-- =====================================================================


-- =====================================================================
-- NOTAS PARA A PARTE 2 (frontend)
--
-- (1) Cancelar sera um simples .update({ status: 'cancelado' }) com
--     .eq('id', ...). Nao precisa de rpc: a operacao e trivial, exige
--     login, e o grant de coluna ja garante que nada alem do status
--     pode ser tocado por esse caminho.
--
-- (2) DOIS NUMEROS DO TOPO VAO FICAR ERRADOS assim que existir
--     agendamento cancelado, e isso nao esta na sua lista:
--
--       faturamentoPrevisto  soma TODOS os agendamentos do filtro,
--                            entao um cancelado continuaria contando
--                            como receita.
--       aguardandoConfirmacao conta status !== 'confirmado', entao um
--                            cancelado apareceria como "aguardando".
--
--     Hoje isso nao aparece porque nao ha cancelado nenhum. No minuto
--     em que a Parte 2 subir, aparece. Vou corrigir os dois junto, ou
--     a funcionalidade nasce mentindo os numeros do dono.
--
-- (3) A trava ja libera o horario e a horarios_ocupados ja filtra
--     cancelado. Nao ha nada a fazer no calculo de horarios livres — o
--     V6b prova isso do lado do banco.
-- =====================================================================
