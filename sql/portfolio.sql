-- =====================================================================
-- MURAL DE FOTOS (galeria "Nossos trabalhos")
-- Rode este arquivo inteiro no Supabase: SQL Editor -> New query -> Run.
-- Antes disso, crie o bucket "portfolio" (Storage -> New bucket -> Public).
-- =====================================================================

-- 1) Tabela que registra cada foto do mural ------------------------------
create table if not exists public.portfolio_items (
  id         uuid primary key default gen_random_uuid(),
  -- caminho do arquivo dentro do bucket (ex.: "1736....-a1b2c3.jpg").
  -- É por ele que apagamos o arquivo no Storage.
  path       text not null unique,
  -- URL pública pronta para usar no <img>. Guardar evita recalcular a cada tela.
  url        text not null,
  criado_em  timestamptz not null default now()
);

-- Ordenamos sempre da mais nova para a mais antiga.
create index if not exists portfolio_items_criado_em_idx
  on public.portfolio_items (criado_em desc);

-- 2) Segurança da TABELA -------------------------------------------------
-- RLS ligado = ninguém acessa nada além do que as políticas abaixo permitem.
alter table public.portfolio_items enable row level security;

-- Qualquer visitante da home pode LER a lista de fotos.
drop policy if exists "portfolio_leitura_publica" on public.portfolio_items;
create policy "portfolio_leitura_publica"
  on public.portfolio_items for select
  using (true);

-- Só quem está logado pode CRIAR registros.
drop policy if exists "portfolio_insert_autenticado" on public.portfolio_items;
create policy "portfolio_insert_autenticado"
  on public.portfolio_items for insert
  to authenticated
  with check (true);

-- Só quem está logado pode APAGAR registros.
drop policy if exists "portfolio_delete_autenticado" on public.portfolio_items;
create policy "portfolio_delete_autenticado"
  on public.portfolio_items for delete
  to authenticated
  using (true);

-- 3) Segurança do BUCKET (arquivos no Storage) ---------------------------
-- Os arquivos do Storage moram na tabela storage.objects. As políticas
-- abaixo valem só para as linhas cujo bucket_id = 'portfolio'.

-- Qualquer um pode baixar/ver as imagens (é o que faz a galeria funcionar).
drop policy if exists "portfolio_arquivos_leitura_publica" on storage.objects;
create policy "portfolio_arquivos_leitura_publica"
  on storage.objects for select
  using (bucket_id = 'portfolio');

-- Só quem está logado pode SUBIR arquivos.
drop policy if exists "portfolio_arquivos_upload_autenticado" on storage.objects;
create policy "portfolio_arquivos_upload_autenticado"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'portfolio');

-- Só quem está logado pode APAGAR arquivos.
drop policy if exists "portfolio_arquivos_delete_autenticado" on storage.objects;
create policy "portfolio_arquivos_delete_autenticado"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'portfolio');
