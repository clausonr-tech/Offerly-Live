import { findBlockedLanguage } from "@/lib/content-limits";
const legit = [
  "Series A, $1.5B AUM", "a16z", "Class of 2025", "Pass the CFA L1",
  "assessment centre", "Scunthorpe", "Pakistan desk", "cocktail reception",
  "I'm an analyst at Jefferies", "Mastercard", "Dick Fuld", "Cockburn & Co",
  "Titan Partners", "Banco de Bogotá", "Aß", "Hasbro", "Shitsuke (5S) lean training",
  "Assange case study", "ASS (Applied Social Science) minor", "Ass't Treasurer",
  "piss-poor" ,"a55et management", "s7ock pitch", "d4mn",
];
for (const t of legit) {
  const k = findBlockedLanguage(t);
  if (k) console.log(`FALSE POSITIVE (${k}): ${JSON.stringify(t)}`);
}
console.log("done");
