/**
 * Faixa fina na base da tela convidando a instalar o app.
 * A decisão de mostrar (e como) vive em useInstalacaoPWA.js.
 */

function IconeCompartilhar() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         style={{ verticalAlign: "-2px" }} aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

export function FaixaInstalar({ iOS, onInstalar, onDispensar }) {
  return (
    <div className="au-install" role="complementary" aria-label="Instalar o app">
      <div className="au-install-mark" aria-hidden="true">Á</div>

      <div className="au-install-txt">
        {iOS ? (
          <>
            <div className="au-install-t">Adicione a Áurea à sua tela inicial</div>
            <div className="au-install-s">
              Toque em <IconeCompartilhar /> Compartilhar e depois em “Adicionar à Tela de Início”.
            </div>
          </>
        ) : (
          <div className="au-install-t">Instale o app da Áurea na sua tela inicial</div>
        )}
      </div>

      {!iOS && (
        <button className="au-btn au-install-btn" onClick={onInstalar}>Instalar</button>
      )}

      <button className="au-install-x" onClick={onDispensar} aria-label="Fechar">✕</button>
    </div>
  );
}
