// DEMAT-BT – Technicien
// Version V9.4.3

// Forcer le mode BRIEF pour l'interface Technicien
state.viewMode = "brief";

// Hook après extraction / cache restore
function afterExtractionTG() {
  if (state.bts && state.bts.length > 0) {
    renderBriefCards(state.bts);
  } else {
    console.warn("Aucun BT à afficher");
  }
}

// Appeler afterExtractionTG() à la fin de l'extraction
// (à placer après la logique existante d'extraction)
