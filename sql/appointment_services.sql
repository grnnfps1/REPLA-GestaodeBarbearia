-- =====================================================================
-- MULTIPLOS SERVICOS POR AGENDAMENTO — PARTE 1 (banco de dados)
--
-- Hoje: appointments.service_id  -> UM servico por agendamento.
-- Depois: appointment_services   -> N servicos por agendamento.
--
-- Este arquivo NAO apaga nada e pode ser rodado mais de uma vez sem
-- estragar os dados (e "idempotente"). A coluna antiga service_id
-- continua intacta ate o frontend parar de usa-la.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
-- Rode PASSO A PASSO, conferindo o resultado de cada bloco.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASSO 0 — PRE-VOO (nao altera nada, so mostra)
--
-- O SQL abaixo assume que appointments.id e services.id sao do tipo
-- uuid. Uma chave estrangeira so funciona se os tipos baterem
-- exatamente. Rode isto ANTES e confira: as tres linhas devem dizer
-- "uuid". Se disserem "bigint", me avise antes de continuar.
-- ---------------------------------------------------------------------
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('appointments', 'id'),
    ('appointments', 'service_id'),
    ('services', 'id')
  )
order by table_name, column_name;


-- ---------------------------------------------------------------------
-- PASSO 1 — A TABELA DE LIGACAO
--
-- Chama-se "tabela de ligacao" porque ela nao guarda informacao
-- propria: so liga duas tabelas. Cada LINHA aqui e um par
-- "este agendamento inclui este servico". Um agendamento com corte +
-- barba vira DUAS linhas, ambas com o mesmo appointment_id.
--
-- Por que uma tabela em vez de mais colunas em appointments?
-- Colunas (service_id_1, service_id_2, service_id_3...) travariam o
-- numero maximo de servicos e deixariam a maioria das linhas com
-- campos vazios. Com a tabela de ligacao, 1 ou 7 servicos custam o
-- mesmo e nada muda no schema.
-- ---------------------------------------------------------------------
create table if not exists public.appointment_services (
  -- ON DELETE CASCADE: se o agendamento for apagado, estas linhas
  -- somem junto. Sem isso sobrariam "filhos" apontando para um pai
  -- que nao existe mais.
  appointment_id uuid not null
    references public.appointments (id) on delete cascade,

  -- ON DELETE RESTRICT: o banco RECUSA apagar um servico que ja foi
  -- usado em algum agendamento. Proposital: apagar "Barba" nao pode
  -- reescrever o historico de quem ja fez barba aqui. Para tirar um
  -- servico do cardapio, use services.ativo = false, como ja e feito.
  service_id uuid not null
    references public.services (id) on delete restrict,

  -- Chave primaria COMPOSTA: a identidade da linha e o par inteiro.
  -- Efeito colateral util: o mesmo servico nao entra duas vezes no
  -- mesmo agendamento (nao existe "corte + corte"). Ver a NOTA 2 no
  -- fim do arquivo se um dia voce precisar de quantidade.
  primary key (appointment_id, service_id)
);

-- A chave primaria ja cria um indice que comeca por appointment_id,
-- otimo para "quais servicos tem este agendamento?".
-- Falta o caminho inverso: o Postgres NAO indexa colunas de chave
-- estrangeira sozinho, e sem este indice toda tentativa de apagar um
-- servico varreria a tabela inteira para checar o RESTRICT.
create index if not exists appointment_services_service_id_idx
  on public.appointment_services (service_id);


-- ---------------------------------------------------------------------
-- PASSO 2 — MIGRACAO DOS AGENDAMENTOS QUE JA EXISTEM
--
-- Le cada agendamento atual e copia o par (id, service_id) para a
-- tabela nova. E uma COPIA: a coluna antiga fica exatamente como esta.
--
-- "where service_id is not null" pula agendamentos sem servico, se
-- houver algum — a nova tabela nao aceita nulo.
--
-- "on conflict do nothing" e o que torna seguro rodar de novo: se a
-- linha ja foi copiada, ele ignora em vez de dar erro de duplicata.
-- ---------------------------------------------------------------------
insert into public.appointment_services (appointment_id, service_id)
select a.id, a.service_id
from public.appointments a
where a.service_id is not null
on conflict (appointment_id, service_id) do nothing;


-- ---------------------------------------------------------------------
-- PASSO 3 — SEGURANCA (RLS), espelhando appointments
--
-- Regra do app: o cliente agenda SEM login (precisa inserir), mas
-- so o dono logado enxerga a agenda (leitura restrita).
--
-- Com RLS ligado e nenhuma politica, ninguem faz nada. Cada politica
-- abaixo abre exatamente uma brecha, e nada alem dela.
-- ---------------------------------------------------------------------
alter table public.appointment_services enable row level security;

-- INSERT liberado para visitante (anon) e para logado (authenticated):
-- e o cliente montando o proprio agendamento.
drop policy if exists "appointment_services_insert_publico" on public.appointment_services;
create policy "appointment_services_insert_publico"
  on public.appointment_services for insert
  to anon, authenticated
  with check (true);

-- SELECT so para quem esta logado. Um visitante consegue CRIAR, mas
-- nao consegue LER — nem os proprios, nem os dos outros. E o mesmo
-- comportamento que appointments ja tem hoje.
drop policy if exists "appointment_services_leitura_autenticado" on public.appointment_services;
create policy "appointment_services_leitura_autenticado"
  on public.appointment_services for select
  to authenticated
  using (true);

-- Nao criamos politica de UPDATE nem de DELETE de proposito: ninguem
-- precisa disso hoje. Apagar o agendamento pai ja limpa estas linhas
-- pelo CASCADE, que e uma acao interna do banco e nao passa pelas
-- politicas de RLS.


-- =====================================================================
-- VERIFICACAO — rode DEPOIS e confira cada resultado
-- =====================================================================

-- V1) As contagens batem? "origem" e "destino" devem ser IGUAIS.
select
  (select count(*) from public.appointments where service_id is not null) as origem,
  (select count(*) from public.appointment_services)                      as destino;

-- V2) Sobrou algum agendamento para tras?
--     DEVE retornar ZERO linhas.
select a.id, a.data_hora, a.cliente_nome, a.service_id
from public.appointments a
left join public.appointment_services aps
  on aps.appointment_id = a.id
where a.service_id is not null
  and aps.appointment_id is null;

-- V3) Algum servico foi copiado ERRADO (nao bate com o original)?
--     DEVE retornar ZERO linhas.
select aps.appointment_id, aps.service_id as novo, a.service_id as antigo
from public.appointment_services aps
join public.appointments a on a.id = aps.appointment_id
where aps.service_id is distinct from a.service_id;

-- V4) Conferencia visual: 5 agendamentos com o nome do servico vindo
--     da tabela NOVA. Devem bater com o que voce ve na tela da agenda.
select a.data_hora, a.cliente_nome, s.nome as servico
from public.appointments a
join public.appointment_services aps on aps.appointment_id = a.id
join public.services s              on s.id = aps.service_id
order by a.data_hora desc
limit 5;

-- V5) As politicas existem e o RLS esta ligado?
--     Devem aparecer 2 politicas, e rls_ligado = true.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'appointment_services';

select relrowsecurity as rls_ligado
from pg_class
where oid = 'public.appointment_services'::regclass;


-- =====================================================================
-- NOTAS PARA AS PROXIMAS PARTES
--
-- (1) appointments.service_id agora esta OBSOLETA. Ela continua sendo
--     a fonte usada pelo App.jsx, e por isso NAO foi apagada. A partir
--     de agora ela e uma COPIA: quem manda e appointment_services.
--     Ela sai na ultima parte, quando o frontend nao depender mais
--     dela. Enquanto isso, todo agendamento novo criado pelo app
--     precisa gravar nos DOIS lugares, senao os dados divergem.
--
-- (2) A chave primaria composta impede o mesmo servico duas vezes no
--     mesmo agendamento. Se um dia precisar de "2x corte", o caminho
--     e trocar a PK por um id proprio e adicionar uma coluna
--     quantidade. Hoje isso nao e necessario.
-- =====================================================================
