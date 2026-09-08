/**
 * Gera os ícones do PWA a partir de um SVG, sem depender de editor gráfico.
 *
 * Rode com:  npm run icones
 *
 * Os PNGs vão para public/icons/ e são versionados — este script só precisa
 * rodar de novo quando o desenho do ícone mudar (por exemplo, quando a
 * barbearia real substituir o "Á" da Áurea pela marca dela).
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const ESPRESSO = "#171310";
const OURO = "#c9a35b";

/**
 * @param {number} lado      tamanho do PNG em pixels
 * @param {number} margem    fração do lado livre em volta do desenho.
 *                           O ícone maskable precisa de margem maior: o
 *                           Android recorta a imagem em círculo, losango ou
 *                           squircle dependendo do aparelho, e só a "zona
 *                           segura" central (80% do lado) é garantida.
 * @param {boolean} comBorda desenha o círculo dourado do monograma do app
 */
function svg(lado, margem, comBorda) {
  const centro = lado / 2;
  const raio = centro * (1 - margem);
  const traco = Math.max(1, lado * 0.018);
  // A letra é dimensionada pelo círculo, não pelo lado, para que o "Á" fique
  // com o mesmo peso visual nas duas variantes.
  const fonte = raio * 1.15;

  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">
  <rect width="${lado}" height="${lado}" fill="${ESPRESSO}"/>
  ${comBorda ? `<circle cx="${centro}" cy="${centro}" r="${raio}" fill="none" stroke="${OURO}" stroke-width="${traco}"/>` : ""}
  <text x="${centro}" y="${centro}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="${fonte}" font-weight="600" fill="${OURO}"
        text-anchor="middle" dominant-baseline="central">Á</text>
</svg>`);
}

// margem menor = desenho maior. O maskable usa margem generosa porque as
// bordas podem ser cortadas.
const ICONES = [
  { arquivo: "icon-192.png", lado: 192, margem: 0.14, comBorda: true },
  { arquivo: "icon-512.png", lado: 512, margem: 0.14, comBorda: true },
  { arquivo: "icon-maskable-512.png", lado: 512, margem: 0.26, comBorda: false },
  // Usado pelo iOS ao adicionar à tela de início.
  { arquivo: "apple-touch-icon.png", lado: 180, margem: 0.14, comBorda: true },
  { arquivo: "favicon-32.png", lado: 32, margem: 0.1, comBorda: false },
];

const destino = new URL("../public/icons/", import.meta.url);
await mkdir(destino, { recursive: true });

for (const { arquivo, lado, margem, comBorda } of ICONES) {
  await sharp(svg(lado, margem, comBorda))
    .png()
    .toFile(new URL(arquivo, destino).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  console.log(`gerado  public/icons/${arquivo}  (${lado}x${lado})`);
}

console.log("\nPronto. Os PNGs são versionados; rode de novo só se o desenho mudar.");
