import { Press_Start_2P } from "next/font/google";

// The one retro/digital face for everything under Interview Prep - the
// platformer game and, now, the page around it. Defined once here rather
// than in each component so the font loader is only ever configured in one
// place; every consumer just imports the resulting object.
export const pixelFont = Press_Start_2P({ subsets: ["latin"], weight: "400" });
