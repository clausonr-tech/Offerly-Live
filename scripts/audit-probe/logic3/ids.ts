import { sims } from "../../draft-occasions-sim";
for (const s of sims()) if (s.profile === "full") console.log(s.id, s.ids.join(","), "lead=" + s.input.type);
