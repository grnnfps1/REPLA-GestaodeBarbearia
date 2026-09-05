import { createClient } from "@supabase/supabase-js";

// As credenciais vêm do arquivo .env.local (que NÃO vai para o GitHub).
// No Vite, só variáveis que começam com VITE_ ficam visíveis para o app.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Aviso claro no console em vez de um erro confuso mais na frente.
  console.error(
    "Supabase não configurado: preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY em .env.local e reinicie o `npm run dev`."
  );
}

export const supabase = createClient(url, anonKey);
