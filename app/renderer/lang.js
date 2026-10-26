// renderer.js imports this first: the language main is in is set before any tab module builds a text.
import { setLang } from "../../src/i18n/i18n.js";

setLang(window.danApi?.lang);
