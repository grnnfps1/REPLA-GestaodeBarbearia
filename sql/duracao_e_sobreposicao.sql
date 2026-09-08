-- =====================================================================
-- DURACAO NO AGENDAMENTO E TRAVA DE SOBREPOSICAO — PARTE 3.1 (banco)
--
-- Hoje: UNIQUE (barber_id, data_hora) impede dois agendamentos que
--       comecam no MESMO instante. Nao impede 10:00 (60 min) e 10:30:
--       para o banco sao horarios diferentes, mas na cadeira e o mesmo
--       barbeiro em dois lugares ao mesmo tempo.
--
-- Depois: cada agendamento guarda quanto dura, e o banco recusa
--         qualquer par de intervalos que se cruze no mesmo barbeiro.
--
-- Decisao de design ja tomada: a duracao fica CARIMBADA na linha de
-- appointments, nao calculada na hora a partir dos servicos. Se a
-- duracao de "Corte" mudar amanha, o atendimento de ontem continua
-- valendo o que valia — verdade historica preservada. E, sem um valor
-- fixo na linha, nao existiria trava automatica: o banco precisa saber
-- o intervalo para conseguir compara-lo.
--
-- Como rodar: Supabase -> SQL Editor -> New query -> cole -> Run.
-- Rode PASSO A PASSO, conferindo o resultado de cada bloco.
--
-- >>> RODE O PASSO 0 PRIMEIRO E ME MANDE O RESULTADO. <<<
-- Os passos 1 a 4 dependem do que o pre-voo mostrar (principalmente
-- 0.4, 0.5 e 0.6) e dois deles tem trechos para voce ajustar.
-- =====================================================================


-- #####################################################################
-- PASSO 0 — PRE-VOO
-- Nada aqui altera coisa alguma. Sao seis leituras.
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0.1 — Os tipos batem?
--
-- Esperado: appointments.data_hora = "timestamp with time zone" e
-- services.duracao_min = "integer".
--
-- appointments.duracao_min NAO deve aparecer (e a coluna que vamos
-- criar). Se aparecer, alguem ja rodou o PASSO 1 — me avise.
-- ---------------------------------------------------------------------
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('appointments', 'data_hora'),
    ('appointments', 'duracao_min'),
    ('appointments', 'status'),
    ('appointments', 'barber_id'),
    ('services',     'duracao_min')
  )
order by table_name, column_name;


-- ---------------------------------------------------------------------
-- 0.2 — A extensao btree_gist existe?
--
-- Por que ela e necessaria: a trava do PASSO 3 precisa combinar duas
-- comparacoes diferentes no mesmo indice — igualdade em barber_id
-- ("e o mesmo barbeiro?") e sobreposicao de intervalo ("os horarios se
-- cruzam?"). O indice GiST sabe fazer sobreposicao de range de fabrica,
-- mas nao sabe fazer igualdade de uuid. O btree_gist ensina isso a ele.
--
-- disponivel = 1   -> da para instalar (o PASSO 3 faz isso).
-- ja_instalada = 1 -> nem precisa instalar.
-- Se disponivel = 0, pare e me avise.
-- ---------------------------------------------------------------------
select
  (select count(*) from pg_available_extensions where name    = 'btree_gist') as disponivel,
  (select count(*) from pg_extension            where extname = 'btree_gist') as ja_instalada;


-- ---------------------------------------------------------------------
-- 0.3 — Volume da migracao retroativa
--
-- sem_servicos e o numero que importa: sao os agendamentos que o
-- PASSO 2 nao consegue calcular e vao receber o valor padrao.
-- barbeiros precisa ser >= 2 para o teste da trava no fim do arquivo.
-- ---------------------------------------------------------------------
select
  (select count(*) from public.appointments)                               as total_agendamentos,
  (select count(distinct appointment_id) from public.appointment_services) as com_servicos,
  (select count(*) from public.appointments a
     where not exists (select 1 from public.appointment_services aps
                       where aps.appointment_id = a.id))                    as sem_servicos,
  (select count(*) from public.barbers)                                     as barbeiros;


-- ---------------------------------------------------------------------
-- 0.4 — Quais valores de status existem de verdade?
--
-- O app so escreve 'confirmado', mas pode haver outros vindos de
-- edicao manual no painel do Supabase. A trava do PASSO 3 precisa saber
-- o texto EXATO do status de cancelado — 'cancelado', 'cancelled' e
-- 'CANCELADO' sao coisas diferentes para o Postgres.
-- ---------------------------------------------------------------------
select status, count(*) as quantos
from public.appointments
group by status
order by quantos desc;


-- ---------------------------------------------------------------------
-- 0.5 — Como se chama a constraint UNIQUE antiga?
--
-- Preciso do nome exato para o PASSO 4. Procure na lista a linha cuja
-- definicao seja UNIQUE (barber_id, data_hora) — o nome provavel e
-- "appointments_barber_id_data_hora_key", mas confirme.
--
-- Aproveite e veja se existe algum CHECK que possa atrapalhar o teste
-- do fim do arquivo (formato de telefone, lista de status, etc).
-- ---------------------------------------------------------------------
select conname as nome, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid = 'public.appointments'::regclass
order by contype, conname;


-- ---------------------------------------------------------------------
-- 0.6 — JA existe sobreposicao nos dados atuais?  [ O BLOQUEADOR ]
--
-- Este e o mais importante do pre-voo. Ao criar a trava, o Postgres
-- valida TODAS as linhas que ja estao la. Se duas se cruzarem, o
-- PASSO 3 falha inteiro e nada e criado.
--
-- E bem possivel que exista: o UNIQUE atual so olha o instante de
-- inicio, entao 10:00 (60 min) e 10:30 convivem hoje sem reclamacao.
--
-- A consulta calcula a duracao na hora, do mesmo jeito que o PASSO 2
-- vai gravar, e procura pares que se cruzam. O ideal e ZERO linhas.
-- Se vier alguma, me mande o resultado: da para resolver cancelando ou
-- reajustando um dos dois, mas e decisao sua, sao clientes reais.
-- ---------------------------------------------------------------------
with dur as (
  select a.id, a.barber_id, a.data_hora, a.status, a.cliente_nome,
         -- 30 e o mesmo padrao que o PASSO 2 usa para quem nao tem servico
         coalesce(sum(s.duracao_min), 30)::int as minutos
  from public.appointments a
  left join public.appointment_services aps on aps.appointment_id = a.id
  left join public.services s                on s.id = aps.service_id
  group by a.id, a.barber_id, a.data_hora, a.status, a.cliente_nome
)
select
  b.nome      as barbeiro,
  x.data_hora as inicio_a, x.minutos as min_a, x.cliente_nome as cliente_a,
  y.data_hora as inicio_b, y.minutos as min_b, y.cliente_nome as cliente_b
from dur x
join dur y
  on  y.barber_id = x.barber_id
  -- id > id: pega cada par uma vez so, e nunca a linha com ela mesma
  and y.id > x.id
  and tstzrange(x.data_hora, x.data_hora + make_interval(mins => x.minutos), '[)')
   && tstzrange(y.data_hora, y.data_hora + make_interval(mins => y.minutos), '[)')
join public.barbers b on b.id = x.barber_id
where x.status is distinct from 'cancelado'
  and y.status is distinct from 'cancelado'
order by b.nome, x.data_hora;


-- #####################################################################
-- >>> PARE AQUI. Rode os seis blocos acima e me mande o resultado. <<<
--
-- O que muda conforme as respostas:
--   0.4 -> o texto do status cancelado no PASSO 3
--   0.5 -> o nome da constraint no PASSO 4
--   0.6 -> se precisamos limpar conflitos antes do PASSO 3
-- #####################################################################




-- #####################################################################
-- PASSO 1 — A COLUNA DE DURACAO
-- #####################################################################

-- ---------------------------------------------------------------------
-- Por que uma coluna integer de minutos e nao um tstzrange gerado?
--
-- Voce pediu o trade-off. A resposta e menos "preferencia" e mais "o
-- Postgres nao deixa":
--
-- Uma coluna GERADA (generated always as ...) exige que a expressao
-- seja IMMUTABLE — mesma entrada, mesma saida, sempre e em qualquer
-- circunstancia. Acontece que somar um interval a um timestamptz e
-- apenas STABLE, nao IMMUTABLE: o Postgres considera que o resultado
-- pode depender do fuso da sessao. Tentar criar a coluna gerada da erro
-- "generation expression is not immutable". O mesmo motivo, alias,
-- impede colocar essa conta direto na trava do PASSO 3 — e por isso que
-- la existe uma funcao propria.
--
-- Entao guardamos o dado mais simples possivel (quantos minutos) e o
-- fim do atendimento e calculado por essa funcao. Vantagem extra: um
-- inteiro e trivial de ler, somar e depurar; um range e mais dificil de
-- olhar e entender no dia a dia.
--
-- if not exists: da para rodar duas vezes sem erro.
-- Fica NULL por enquanto — os antigos ainda nao tem valor.
-- ---------------------------------------------------------------------
alter table public.appointments
  add column if not exists duracao_min integer;

comment on column public.appointments.duracao_min is
  'Duracao carimbada no momento do agendamento, em minutos. Copia da soma dos '
  'servicos; nao recalcular a partir de services, para preservar a verdade '
  'historica se o cadastro do servico mudar depois.';


-- #####################################################################
-- PASSO 2 — MIGRACAO RETROATIVA
-- #####################################################################

-- ---------------------------------------------------------------------
-- 2.1 — Soma a duracao dos servicos de cada agendamento existente.
--
-- "where a.duracao_min is null" faz disto um preenchimento de buracos,
-- nao um recalculo: rodar de novo nao mexe em quem ja tem valor. Isso
-- importa porque, depois da Parte 3.2, o app grava a duracao real na
-- criacao — e um recalculo cego sobrescreveria o carimbo historico,
-- justamente o que a decisao de design quer evitar.
-- ---------------------------------------------------------------------
update public.appointments a
set duracao_min = t.total
from (
  select aps.appointment_id, sum(s.duracao_min)::int as total
  from public.appointment_services aps
  join public.services s on s.id = aps.service_id
  group by aps.appointment_id
) t
where t.appointment_id = a.id
  and a.duracao_min is null;


-- ---------------------------------------------------------------------
-- 2.2 — Sobrou alguem sem duracao?
--
-- Sao os agendamentos sem nenhuma linha em appointment_services (o
-- numero que o 0.3 mostrou como "sem_servicos"). Confira que bate.
-- ---------------------------------------------------------------------
select count(*) as ainda_sem_duracao
from public.appointments
where duracao_min is null;


-- ---------------------------------------------------------------------
-- 2.3 — Valor padrao para os orfaos: 30 minutos.
--
-- Por que 30 e o default seguro, e nao 15 nem 60:
--
-- O app oferece horarios de 30 em 30 minutos (PASSO_MINUTOS = 30, no
-- App.jsx). Com 30, cada agendamento antigo ocupa exatamente uma casa
-- da grade — o de 10:00 vai ate 10:30, e o de 10:30 encosta sem cruzar.
-- A trava passa a se comportar para esses registros exatamente como o
-- UNIQUE antigo se comportava: nem mais frouxa, nem mais apertada.
--
-- Com 15 ficaria frouxo demais: deixaria marcar 10:15 por cima de um
-- corte real de 30 min. Com 60 ficaria apertado demais: 10:00 passaria
-- a bloquear 10:30, e horarios que o app oferece hoje comecariam a ser
-- recusados sem motivo.
--
-- Rode so se o 2.2 acusou mais de zero.
-- ---------------------------------------------------------------------
update public.appointments
set duracao_min = 30
where duracao_min is null;


-- ---------------------------------------------------------------------
-- 2.4 — Agora sim: NOT NULL, default e o CHECK de sanidade.
--
-- E SEGURO tornar NOT NULL depois do 2.1 + 2.3, porque nao sobra mais
-- nenhuma linha nula (confirme rodando o 2.2 de novo: tem que dar 0).
--
-- Mais que seguro, e OBRIGATORIO. Se um dia entrasse uma linha com
-- duracao nula, a trava do PASSO 3 montaria o intervalo [inicio, NULL),
-- que em Postgres significa "daqui ate o infinito" — esse agendamento
-- passaria a colidir com TODOS os seguintes daquele barbeiro. A trava
-- viraria um bloqueio geral da agenda.
--
-- Por que tambem um DEFAULT 30, e nao so NOT NULL:
--
--   Esta sub-parte 3.1 vai para producao ANTES da 3.2. O app que esta
--   no ar hoje nao envia duracao_min. Sem default, todo agendamento
--   novo passaria a falhar no instante em que voce rodar este bloco —
--   voce derrubaria os agendamentos de clientes reais ate a 3.2 subir.
--   Com o default, o app atual continua funcionando (tudo vira 30 min,
--   que e o comportamento de hoje) e a 3.2 passa a mandar o valor certo.
--
--   Depois que a 3.2 estiver no ar e sempre enviando duracao_min, da
--   para remover o default, se voce preferir que um envio esquecido
--   falhe alto em vez de gravar 30 em silencio:
--     alter table public.appointments alter column duracao_min drop default;
--
-- O CHECK > 0 fecha um buraco sutil: duracao zero produz um intervalo
-- VAZIO, e intervalo vazio nao se sobrepoe a nada. Um agendamento de
-- 0 min passaria despercebido pela trava.
-- ---------------------------------------------------------------------
alter table public.appointments
  alter column duracao_min set not null,
  alter column duracao_min set default 30;

alter table public.appointments
  drop constraint if exists appointments_duracao_positiva;

alter table public.appointments
  add constraint appointments_duracao_positiva check (duracao_min > 0);


-- #####################################################################
-- PASSO 3 — A TRAVA DE SOBREPOSICAO (o coracao)
-- #####################################################################

-- ---------------------------------------------------------------------
-- 3.1 — A extensao.
--
-- No Supabase as extensoes moram no schema "extensions". Se der erro
-- dizendo que o schema nao existe, tire o "with schema extensions".
-- Se o 0.2 mostrou ja_instalada = 1, este comando nao faz nada.
-- ---------------------------------------------------------------------
create extension if not exists btree_gist with schema extensions;


-- ---------------------------------------------------------------------
-- 3.2 — A funcao que diz onde o atendimento termina.
--
-- Existe por um motivo so: a trava e um indice, e indice exige
-- expressao IMMUTABLE. Como explicado no PASSO 1, "timestamptz +
-- interval" e apenas STABLE, entao nao pode entrar direto ali.
--
-- Aqui declaramos IMMUTABLE de proposito, e neste caso especifico e
-- verdade: make_interval(mins => n) produz um intervalo so de horas e
-- minutos, sem dias nem meses. O que torna a soma dependente de fuso
-- sao justamente dias e meses — por causa do horario de verao, um "dia"
-- pode ter 23 ou 25 horas. Somar minutos puros e aritmetica direta na
-- linha do tempo: da o mesmo resultado em qualquer fuso, sempre.
--
-- set search_path = '': boa pratica de seguranca para funcao usada em
-- indice — impede que alguem crie um objeto de mesmo nome em outro
-- schema e sequestre o que a funcao chama. Por isso o make_interval vai
-- escrito com pg_catalog na frente.
-- ---------------------------------------------------------------------
create or replace function public.fim_do_atendimento(inicio timestamptz, minutos integer)
returns timestamptz
language sql
immutable
parallel safe
returns null on null input
set search_path = ''
as $$
  select inicio + pg_catalog.make_interval(mins => minutos);
$$;


-- ---------------------------------------------------------------------
-- 3.3 — A EXCLUSION CONSTRAINT.
--
-- Como ler: "recuse a nova linha se existir outra em que barber_id seja
-- IGUAL (=) E o intervalo de tempo se SOBREPONHA (&&)". As duas
-- condicoes valem juntas — barbeiro diferente no mesmo horario passa;
-- mesmo barbeiro em horarios que se cruzam, nao.
--
-- '[)' e o detalhe que faz os horarios encostados funcionarem:
-- colchete = inicio INCLUIDO, parentese = fim EXCLUIDO. Um corte das
-- 10:00 as 10:30 ocupa [10:00, 10:30) e o seguinte comeca em [10:30,
-- ...): eles se tocam mas nao se cruzam. Com '[]' nos dois lados, dois
-- agendamentos colados seriam recusados sem necessidade.
--
-- STATUS — como tratei:
--
-- O "where" no fim faz disto uma trava PARCIAL: ela so vale para as
-- linhas que casam com a condicao. Cancelado nao entra no indice,
-- entao nao ocupa horario — cancelou, a vaga abre na hora, que e o
-- comportamento desejado.
--
-- Usei "is distinct from" e nao "<> 'cancelado'" por causa do NULL: em
-- SQL, NULL <> 'cancelado' nao da verdadeiro, da DESCONHECIDO, e a
-- linha ficaria de fora do indice. Ou seja, um agendamento com status
-- nulo nao bloquearia horario nenhum — silenciosamente. Com "is
-- distinct from", NULL entra normalmente e bloqueia, que e o lado
-- seguro do erro.
--
-- >>> AJUSTE ANTES DE RODAR <<<
-- Troque 'cancelado' pelo texto exato que apareceu no 0.4. Se ainda nao
-- existe status de cancelamento, pode deixar como esta: a condicao nao
-- atrapalha nada hoje e ja fica pronta para quando existir.
--
-- Se der "conflicting key value violates exclusion constraint" AQUI, e
-- porque os dados atuais ja tem sobreposicao: volte ao 0.6.
-- ---------------------------------------------------------------------
alter table public.appointments
  add constraint appointments_sem_sobreposicao
  exclude using gist (
    barber_id with =,
    tstzrange(data_hora, public.fim_do_atendimento(data_hora, duracao_min), '[)') with &&
  )
  where (status is distinct from 'cancelado');


-- ---------------------------------------------------------------------
-- 3.4 — QUAL ERRO O POSTGRES DEVOLVE (para a Parte 3.2 tratar)
--
--   codigo : 23P01   (exclusion_violation)
--   message: conflicting key value violates exclusion constraint
--            "appointments_sem_sobreposicao"
--
-- Atencao: e um codigo DIFERENTE do 23505 (unique_violation) que o
-- App.jsx trata hoje. Enquanto o UNIQUE antigo existir (ate o PASSO 4),
-- os dois podem acontecer. Depois do PASSO 4, so o 23P01.
--
-- Ou seja: o frontend precisa passar a tratar os DOIS codigos, senao o
-- cliente vai ver "erro inesperado" em vez de "esse horario acabou de
-- ser reservado". Isso e a sub-parte 3.2 — nao mexemos no app agora.
-- ---------------------------------------------------------------------


-- #####################################################################
-- PASSO 4 — APOSENTAR O UNIQUE ANTIGO
-- #####################################################################

-- ---------------------------------------------------------------------
-- Existe janela desprotegida entre tirar o velho e o novo valer?
--
-- Nao, e a ordem deste arquivo e justamente o que evita isso: o PASSO 3
-- cria a trava nova ANTES de o PASSO 4 remover a antiga. Entre um e
-- outro as duas convivem, e conviver e inofensivo — a nova e mais
-- rigorosa que a velha em tudo que importa (quem barra sobreposicao
-- tambem barra inicio identico, que e um caso particular de
-- sobreposicao). No maximo o Postgres reclama pela constraint antiga
-- primeiro; a linha e recusada de qualquer forma.
--
-- Se fosse ao contrario — dropar antes de criar — a janela existiria de
-- verdade: entre os dois comandos, dois clientes poderiam pegar o mesmo
-- horario. Pior: o PASSO 3 pode FALHAR (se o 0.6 acusar conflito), e
-- voce ficaria sem trava nenhuma sem perceber.
--
-- Cada ALTER TABLE roda na propria transacao no SQL Editor. Se quiser
-- eliminar ate a janela de milissegundos entre um e outro, rode o 3.3 e
-- este PASSO 4 juntos dentro de um begin/commit.
--
-- O que se perde: o UNIQUE antigo valia para TODAS as linhas, inclusive
-- canceladas. A trava nova ignora canceladas de proposito. Entao dois
-- agendamentos cancelados no mesmo horario passam a ser permitidos —
-- que e exatamente o que se quer.
--
-- >>> AJUSTE ANTES DE RODAR <<<
-- Troque o nome abaixo pelo que apareceu no 0.5.
-- ---------------------------------------------------------------------
alter table public.appointments
  drop constraint if exists appointments_barber_id_data_hora_key;


-- =====================================================================
-- VERIFICACOES — rode DEPOIS de tudo
-- =====================================================================

-- ---------------------------------------------------------------------
-- V1) Toda linha tem duracao?
--     preenchidas deve ser IGUAL a total, e nulas deve ser 0.
--     menor tem que ser > 0 (senao o CHECK do 2.4 nao teria passado).
-- ---------------------------------------------------------------------
select
  count(*)                                    as total,
  count(duracao_min)                          as preenchidas,
  count(*) filter (where duracao_min is null) as nulas,
  min(duracao_min)                            as menor,
  max(duracao_min)                            as maior
from public.appointments;


-- ---------------------------------------------------------------------
-- V2) A trava existe mesmo?
--     Deve aparecer 1 linha, tipo "x" (de exclusion), e a definicao
--     deve terminar com o WHERE do status.
-- ---------------------------------------------------------------------
select conname as nome, contype as tipo, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid = 'public.appointments'::regclass
  and contype = 'x';


-- ---------------------------------------------------------------------
-- V3) O TESTE DE VERDADE — a trava funciona?
--
-- Roda tudo dentro de begin/rollback: NADA fica gravado, mesmo dando
-- certo. As datas sao em 2099 para nao encostar em dado real.
--
-- Precisa de pelo menos 2 barbeiros (confira o 0.3).
--
-- Rode o bloco INTEIRO de uma vez e leia o resultado assim:
--
--   A, B e C devem PASSAR sem erro.
--   D deve FALHAR com: 23P01 conflicting key value violates
--                      exclusion constraint "appointments_sem_sobreposicao"
--
-- Se D passar, a trava NAO esta funcionando — me avise.
-- Se A, B ou C falhar, me mande o erro: provavelmente e um CHECK de
-- telefone ou de status que apareceu no 0.5.
--
-- Depois do erro em D o Postgres aborta a transacao e as linhas
-- seguintes reclamam de "current transaction is aborted" — e esperado.
-- O rollback no fim limpa tudo. Por seguranca, se o editor ja tiver
-- desfeito sozinho, rode um "rollback;" avulso depois.
-- ---------------------------------------------------------------------
begin;

-- A) barbeiro 1, 10:00, 30 min -> DEVE PASSAR
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 10:00:00-03', 30, 'Teste A', '(21) 90000-0000', 'confirmado');

-- B) barbeiro 2, MESMO horario -> DEVE PASSAR
--    (barbeiro diferente nao conflita: e o "with =" no barber_id)
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id offset 1 limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 10:00:00-03', 30, 'Teste B', '(21) 90000-0000', 'confirmado');

-- C) barbeiro 1, 10:30 — encostado no A, sem cruzar -> DEVE PASSAR
--    (e o teste do '[)': o A ocupa ate 10:30 exclusive)
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 10:30:00-03', 30, 'Teste C', '(21) 90000-0000', 'confirmado');

-- D) barbeiro 1, 10:15 — cai no meio do A -> DEVE FALHAR (23P01)
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 10:15:00-03', 30, 'Teste D', '(21) 90000-0000', 'confirmado');

rollback;


-- ---------------------------------------------------------------------
-- V4) Cancelado libera o horario?
--
-- Mesma ideia: E passa, e F passa POR CIMA de E porque E esta
-- cancelado. Se F falhar, o "where" do status nao esta pegando —
-- provavelmente o texto usado no 3.3 nao bate com o do 0.4.
--
-- Se voce ainda nao tem status de cancelamento, pule esta verificacao.
-- ---------------------------------------------------------------------
begin;

-- E) cancelado, ocupando 14:00
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 14:00:00-03', 30, 'Teste E', '(21) 90000-0000', 'cancelado');

-- F) confirmado no MESMO horario -> DEVE PASSAR
insert into public.appointments
  (barber_id, service_id, data_hora, duracao_min, cliente_nome, cliente_telefone, status)
values
  ((select id from public.barbers  order by id limit 1),
   (select id from public.services order by id limit 1),
   timestamptz '2099-01-01 14:00:00-03', 30, 'Teste F', '(21) 90000-0000', 'confirmado');

rollback;


-- =====================================================================
-- NOTAS PARA A SUB-PARTE 3.2 (frontend) — nada disso e feito agora
--
-- (1) O App.jsx passa a enviar duracao_min no insert, com a soma das
--     duracoes dos servicos escolhidos — o mesmo totalDuracao que ja
--     esta calculado na tela.
--
-- (2) O tratamento de erro precisa aceitar 23P01 alem de 23505. Hoje o
--     codigo so olha 23505 e cairia na mensagem generica.
--
-- (3) O calculo de horarios livres muda de natureza. Hoje ele compara
--     instantes de inicio; vai precisar comparar INTERVALOS: um corte
--     de 60 min as 10:00 tem que apagar 10:00 e 10:30 da lista, e um
--     servico de 60 min nao pode ser oferecido as 18:30 se a barbearia
--     fecha as 19:00.
--
-- (4) A trava do banco NAO substitui esse calculo: ela e a rede de
--     seguranca para dois clientes clicando ao mesmo tempo. Sem o
--     calculo, o app ofereceria horarios que o banco vai recusar.
--
-- (5) Continua valendo o combinado da Parte 2: a gravacao em duas
--     etapas (appointments + appointment_services) nao e atomica. Uma
--     funcao rpc resolveria as duas de uma vez. Boa hora para fazer
--     isso e junto da 3.2, porque a rpc tambem seria o lugar natural
--     para calcular a duracao no servidor, em vez de confiar no valor
--     que o navegador manda.
-- =====================================================================
