#!/usr/bin/env python3
# ---------------------------------------------------------------
# Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante (GPL-3.0)
# servidor-sem-cache.py
# Servidor HTTP da pasta atual que manda o navegador revalidar cada
# arquivo a cada carregamento. Assim, alterações em .js/.css valem
# ao recarregar a página, sem precisar limpar o cache.
#
# Uso: python3 servidor-sem-cache.py [porta]   (padrão: 8880)
# ---------------------------------------------------------------

import http.server
import sys

sys.stderr.reconfigure(line_buffering=True)


class SemCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8880
http.server.ThreadingHTTPServer(('', porta), SemCache).serve_forever()
