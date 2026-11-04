/* =========================================================================
   sigla.js - Aba "Conferencia SIGLA"
   -------------------------------------------------------------------------
   Compara as ocorrencias finalizadas do Fluxo (historico) com o relatorio
   exportado do SIGLA (relocorrencias.TXT, separado por TAB).
   Regra: tudo o que esta no Fluxo precisa estar no SIGLA. O contrario nao
   e regra, entao registros que existem so no SIGLA nao sao apontados.
   Casamento: carro + data + numero de servico + hora (tolerancia 30 min).
   O relatorio fica so na memoria da pagina (nada e gravado).
   ========================================================================= */
(function () {
  "use strict";

  var TOL_MIN = 30;               // tolerancia de hora (quebra e termino)
  var DIA_MS = 86400000;
  var COLS_OBRIG = ["prefixo", "data_hora_inicio", "servico"];

  var relatorio = null;           // { nome, registros: [...], de, ate }
  var resultado = [];             // ultima comparacao

  /* ---------------- Helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function hm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function fmtBR(ms) {
    if (ms == null || isNaN(ms)) return "";
    var d = new Date(ms);
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + String(d.getFullYear()).slice(2) + " " + hm(d);
  }
  function fmtDia(ymdStr) {
    if (!ymdStr) return "";
    var p = ymdStr.slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0].slice(2) : ymdStr;
  }
  function difMin(a, b) { return Math.round(Math.abs(a - b) / 60000); }

  /* ---------------- Normalizacoes ---------------- */
  function normCarro(c) { return String(c || "").replace(/\s+/g, "").toUpperCase(); }
  function servTokens(s) { return (String(s || "").match(/\d{8}/g) || []).sort(); }
  function matNorm(m) {
    return (String(m || "").match(/\d+/g) || []).map(function (x) { return x.replace(/^0+/, ""); }).filter(Boolean);
  }
  function siglas(txt) {
    return (String(txt || "").toUpperCase().match(/[A-Z]{3,4}/g) || []).filter(function (x) { return x !== "VIA"; });
  }
  function segueDe(carro, segue) {
    var c = normCarro(carro), s = normCarro(segue);
    return (s && s !== c) ? s : "";
  }
  // "01/11/2026 00:40:00" -> ms (hora local)
  function parseBR(s) {
    var m = String(s || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  }
  function msLocal(dataYmd, hora) {
    if (!dataYmd || !hora) return null;
    var ms = Date.parse(String(dataYmd).slice(0, 10) + "T" + String(hora).slice(0, 5) + ":00");
    return isNaN(ms) ? null : ms;
  }

  /* ---------------- Empresa (mesma regra do app) ---------------- */
  var SUFIXO_EMP = { U: "UTIL", S: "SAMP", F: "RAF", R: "REX" };
  function empresaKey(regional, carro) {
    if (regional && /^(UTIL|SAMP|RAF|REX)$/.test(regional)) return regional;
    var m = String(carro || "").match(/\.([A-Za-z])\s*$/);
    return m ? (SUFIXO_EMP[m[1].toUpperCase()] || "") : "";
  }

  /* ---------------- Leitura do relatorio ---------------- */
  function decodificar(buf) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("windows-1252").decode(buf); }
  }
  // TSV com campos entre aspas que podem ter quebra de linha e "" escapado
  function parseTSV(txt) {
    var rows = [], row = [], campo = "", i = 0, n = txt.length, emAspas = false, inicioCampo = true;
    if (txt.charCodeAt(0) === 0xFEFF) i = 1;
    for (; i < n; i++) {
      var ch = txt[i];
      if (emAspas) {
        if (ch === '"') {
          if (txt[i + 1] === '"') { campo += '"'; i++; }
          else { emAspas = false; }
        } else { campo += ch; }
        continue;
      }
      if (ch === '"' && inicioCampo) { emAspas = true; inicioCampo = false; continue; }
      if (ch === "\t") { row.push(campo); campo = ""; inicioCampo = true; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(campo); rows.push(row); row = []; campo = ""; inicioCampo = true; continue; }
      campo += ch; inicioCampo = false;
    }
    if (campo !== "" || row.length) { row.push(campo); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  }
  function montarRelatorio(nome, txt) {
    var linhas = parseTSV(txt);
    if (!linhas.length) throw new Error("Arquivo vazio.");
    var head = linhas.shift().map(function (h) { return String(h).trim().toLowerCase(); });
    var faltam = COLS_OBRIG.filter(function (c) { return head.indexOf(c) === -1; });
    if (faltam.length) throw new Error("Colunas obrigatorias ausentes: " + faltam.join(", ") + ". Use o relatorio de ocorrencias do SIGLA (TXT separado por TAB).");
    var regs = [];
    linhas.forEach(function (cols, idx) {
      var r = {}; head.forEach(function (h, i) { r[h] = cols[i] == null ? "" : String(cols[i]).trim(); });
      var ini = parseBR(r.data_hora_inicio);
      if (ini == null) return;
      regs.push({
        idx: idx,
        carro: normCarro(r.prefixo),
        carroSegue: segueDe(r.prefixo, r.prefixo_novo),
        servico: r.servico,
        servTok: servTokens(r.servico),
        iniMs: ini,
        dia: ymd(new Date(ini)),
        fimMs: parseBR(r.data_hora_fim),
        dataServico: (function () { var t = parseBR(r.data_servico); return t == null ? "" : ymd(new Date(t)); })(),
        matricula: r.matricula, nome: r.nome_guerra || r.nome,
        motivo: r.motivo_ocorrencia, local: r.local,
        origem: r.origem, destino: r.destino, descricaoLinha: r.descricao_linha,
        empresa: empresaKey(r.regional_veiculo, r.prefixo)
      });
    });
    if (!regs.length) throw new Error("Nenhum registro valido encontrado no arquivo.");
    var dias = regs.map(function (r) { return r.dia; }).sort();
    return { nome: nome, registros: regs, de: dias[0], ate: dias[dias.length - 1] };
  }

  /* ---------------- Ocorrencias do Fluxo ---------------- */
  function fluxoNorm(o) {
    var ini = msLocal(o.dataOcorrencia, o.horaQuebra);
    if (ini == null && o.inicioEm) ini = new Date(o.inicioEm).getTime();
    if (ini == null && o.abertaEm) ini = new Date(o.abertaEm).getTime();
    var fim = msLocal(o.terminoData, o.terminoSocorro);
    if (fim == null && o.socorroEm) fim = new Date(o.socorroEm).getTime();
    if (fim == null && o.finalizadaEm) fim = new Date(o.finalizadaEm).getTime();
    return {
      o: o, id: o.id,
      carro: normCarro(o.carro), carroSegue: segueDe(o.carro, o.carroSegue),
      servico: o.servico || "", servTok: servTokens(o.servico),
      iniMs: ini, dia: o.dataOcorrencia || (ini != null ? ymd(new Date(ini)) : ""),
      fimMs: fim, dataViagem: o.dataViagem || "",
      matricula: o.matricula || "", linha: o.linha || "",
      empresa: empresaKey(o.regional, o.carro)
    };
  }

  /* ---------------- Casamento ---------------- */
  function interseccao(a, b) { return a.some(function (x) { return b.indexOf(x) > -1; }); }
  function pontuar(f, s) {
    if (f.iniMs == null) return null;
    var dt = Math.abs(f.iniMs - s.iniMs);
    if (dt > 1.5 * DIA_MS) return null;
    var carro = !!f.carro && f.carro === s.carro;
    var serv = f.servTok.length && s.servTok.length && interseccao(f.servTok, s.servTok);
    if (!carro && !serv) return null;                   // precisa de carro OU servico em comum
    var hora = dt <= TOL_MIN * 60000;
    var dia = f.dia === s.dia;
    var p = (carro ? 3 : 0) + (serv ? 3 : 0) + (hora ? 2 : 0) + (dia ? 1 : 0);
    return p >= 4 ? { p: p, dt: dt } : null;
  }
  function casar(fluxo, sigla) {
    var pares = [];
    fluxo.forEach(function (f, i) {
      sigla.forEach(function (s, j) {
        var r = pontuar(f, s); if (r) pares.push({ i: i, j: j, p: r.p, dt: r.dt });
      });
    });
    pares.sort(function (a, b) { return (b.p - a.p) || (a.dt - b.dt); });
    var usadoF = {}, usadoS = {}, mapa = {};
    pares.forEach(function (x) {
      if (usadoF[x.i] || usadoS[x.j]) return;
      usadoF[x.i] = usadoS[x.j] = true; mapa[x.i] = sigla[x.j];
    });
    return mapa;
  }

  /* ---------------- Comparacao campo a campo ---------------- */
  // nivel: "chave" (carro, data, servico, hora) ou "outro"
  function comparar(f, s) {
    var d = [];
    function dif(campo, nivel, vf, vs) { d.push({ campo: campo, nivel: nivel, fluxo: vf || "(vazio)", sigla: vs || "(vazio)" }); }

    if (f.carro !== s.carro) dif("Carro", "chave", f.carro, s.carro);

    if (f.dia !== s.dia) dif("Data da ocorrencia", "chave", fmtDia(f.dia), fmtDia(s.dia));

    var fs = f.servTok.join("/"), ss = s.servTok.join("/");
    if (fs !== ss) dif("Servico", "chave", f.servico, s.servico);

    if (f.iniMs != null) {
      var dq = difMin(f.iniMs, s.iniMs);
      if (dq > TOL_MIN) dif("Hora da quebra", "chave", hm(new Date(f.iniMs)), hm(new Date(s.iniMs)) + "  (" + dq + " min de diferenca)");
    }

    if (f.fimMs != null && s.fimMs != null) {
      var dfim = difMin(f.fimMs, s.fimMs);
      if (dfim > TOL_MIN) dif("Termino do socorro", "outro", fmtBR(f.fimMs), fmtBR(s.fimMs) + "  (" + dfim + " min)");
    } else if (f.fimMs != null && s.fimMs == null) {
      dif("Termino do socorro", "outro", fmtBR(f.fimMs), "");
    }

    if (f.carroSegue !== s.carroSegue) dif("Carro que segue", "outro", f.carroSegue, s.carroSegue);

    if (f.dataViagem && s.dataServico && f.dataViagem !== s.dataServico) dif("Data da viagem", "outro", fmtDia(f.dataViagem), fmtDia(s.dataServico));

    var mf = matNorm(f.matricula), ms = matNorm(s.matricula);
    if (mf.length && ms.length && !interseccao(mf, ms)) dif("Matricula", "outro", f.matricula, s.matricula);

    var lf = siglas(f.linha), ls = [String(s.origem || "").toUpperCase(), String(s.destino || "").toUpperCase()].filter(Boolean);
    if (lf.length >= 2 && ls.length === 2) {
      var ok = lf.slice().sort().join("|") === ls.slice().sort().join("|");
      if (!ok) dif("Linha (origem x destino)", "outro", f.linha, ls.join(" x ") + (s.descricaoLinha ? "  [" + s.descricaoLinha + "]" : ""));
    }
    return d;
  }

  /* ---------------- Execucao ---------------- */
  function fluxoNoPeriodo() {
    var de = $("#sgDe").value || (relatorio && relatorio.de) || "";
    var ate = $("#sgAte").value || (relatorio && relatorio.ate) || "";
    var emp = $all("#sgEmpresa input:checked").map(function (c) { return c.value; });
    return window.Store.listarFinalizadas().map(fluxoNorm).filter(function (f) {
      if (emp.length && emp.indexOf(f.empresa) === -1) return false;
      if (de && (!f.dia || f.dia < de)) return false;
      if (ate && (!f.dia || f.dia > ate)) return false;
      return true;
    });
  }
  function processar() {
    if (!relatorio) { resultado = []; render(); return; }
    var fluxo = fluxoNoPeriodo();
    var mapa = casar(fluxo, relatorio.registros);
    resultado = fluxo.map(function (f, i) {
      var s = mapa[i];
      if (!s) return { tipo: "faltando", f: f, s: null, difs: [] };
      var difs = comparar(f, s);
      return { tipo: difs.length ? "divergente" : "ok", f: f, s: s, difs: difs };
    });
    var ordem = { faltando: 0, divergente: 1, ok: 2 };
    resultado.sort(function (a, b) { return (ordem[a.tipo] - ordem[b.tipo]) || ((a.f.iniMs || 0) - (b.f.iniMs || 0)); });
    render();
  }

  /* ---------------- Tela ---------------- */
  var ROTULO = {
    faltando:   { txt: "Faltando no SIGLA", cls: "sg-falta" },
    divergente: { txt: "Divergente",        cls: "sg-div" },
    ok:         { txt: "OK",                cls: "sg-ok" }
  };
  function render() {
    var info = $("#sgInfo"), resumo = $("#sgResumo"), tbl = $("#tblSigla");
    if (!relatorio) {
      info.textContent = "Nenhum relatorio carregado.";
      resumo.innerHTML = "";
      tbl.innerHTML = '<tbody><tr><td style="text-align:center;color:#888;padding:20px">Carregue o relatorio de ocorrencias exportado do SIGLA (TXT) para iniciar a conferencia.</td></tr></tbody>';
      return;
    }
    info.textContent = relatorio.nome + "  |  " + relatorio.registros.length + " registros no SIGLA  |  periodo do relatorio: " +
      fmtDia(relatorio.de) + " a " + fmtDia(relatorio.ate);

    var c = { faltando: 0, divergente: 0, ok: 0 };
    resultado.forEach(function (r) { c[r.tipo]++; });
    resumo.innerHTML =
      '<span class="sg-chip">Fluxo no periodo <b>' + resultado.length + "</b></span>" +
      '<span class="sg-chip sg-falta">Faltando no SIGLA <b>' + c.faltando + "</b></span>" +
      '<span class="sg-chip sg-div">Divergentes <b>' + c.divergente + "</b></span>" +
      '<span class="sg-chip sg-ok">OK <b>' + c.ok + "</b></span>";

    var mostrarOk = $("#sgMostrarOk").checked;
    var termo = ($("#sgBusca").value || "").toLowerCase();
    var lista = resultado.filter(function (r) {
      if (!mostrarOk && r.tipo === "ok") return false;
      if (!termo) return true;
      return [r.f.carro, r.f.servico, r.f.linha, r.f.o.motorista, r.s && r.s.carro, r.s && r.s.servico].join(" ").toLowerCase().indexOf(termo) > -1;
    });

    var rows = lista.map(function (r) {
      var f = r.f, s = r.s, rot = ROTULO[r.tipo];
      var difs;
      if (r.tipo === "faltando") {
        difs = '<span class="sg-nota">Nenhum registro no SIGLA com o mesmo carro/servico nesta data e hora. Lancar no SIGLA.</span>';
      } else if (r.tipo === "ok") {
        difs = '<span class="sg-nota">Confere (SIGLA: ' + esc(fmtBR(s.iniMs)) + ")</span>";
      } else {
        difs = '<ul class="sg-difs">' + r.difs.map(function (d) {
          return '<li class="' + (d.nivel === "chave" ? "chave" : "") + '"><b>' + esc(d.campo) + ":</b> Fluxo <code>" + esc(d.fluxo) +
            "</code> | SIGLA <code>" + esc(d.sigla) + "</code></li>";
        }).join("") + "</ul>";
      }
      return "<tr>" +
        '<td><span class="sg-tag ' + rot.cls + '">' + rot.txt + "</span></td>" +
        "<td>" + esc(fmtBR(f.iniMs)) + "</td>" +
        "<td>" + esc(f.o.carro || "") + "</td>" +
        "<td>" + esc(f.servico) + "</td>" +
        "<td>" + esc(f.linha) + "</td>" +
        '<td class="sg-col-difs">' + difs + "</td>" +
        '<td><button class="btn blue sm" data-action="detalhe" data-id="' + esc(f.id) + '">Ver</button></td>' +
        "</tr>";
    }).join("");

    tbl.innerHTML = "<thead><tr><th>Situacao</th><th>Quebra (Fluxo)</th><th>Carro</th><th>Servico</th><th>Linha</th><th>Diferencas (Fluxo x SIGLA)</th><th></th></tr></thead><tbody>" +
      (rows || '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px">' +
        (resultado.length ? "Nenhuma pendencia. Todas as ocorrencias do Fluxo no periodo conferem com o SIGLA." : "Nenhuma ocorrencia finalizada do Fluxo no periodo/filtro selecionado.") +
        "</td></tr>") + "</tbody>";
  }

  function carregarArquivo(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        relatorio = montarRelatorio(file.name, decodificar(fr.result));
        $("#sgDe").value = relatorio.de;
        $("#sgAte").value = relatorio.ate;
        processar();
      } catch (e) {
        relatorio = null; resultado = []; render();
        alert("Nao foi possivel ler o relatorio: " + e.message);
      }
    };
    fr.readAsArrayBuffer(file);
  }

  function wire() {
    if (!$("#view-sigla")) return;
    $("#sgArquivo").addEventListener("change", function () {
      var f = this.files && this.files[0]; if (f) carregarArquivo(f); this.value = "";
    });
    $("#sgDe").addEventListener("change", processar);
    $("#sgAte").addEventListener("change", processar);
    $("#sgEmpresa").addEventListener("change", processar);
    $("#sgMostrarOk").addEventListener("change", render);
    $("#sgBusca").addEventListener("input", render);
    $("#sgPeriodoRel").addEventListener("click", function () {
      if (!relatorio) return;
      $("#sgDe").value = relatorio.de; $("#sgAte").value = relatorio.ate; processar();
    });
    // Reprocessa ao abrir a aba (pega edicoes feitas no historico)
    $all('.nav button[data-view="sigla"]').forEach(function (b) { b.addEventListener("click", processar); });
    render();
  }

  window.SiglaConferencia = { processar: processar, _parseTSV: parseTSV, _montar: montarRelatorio, _comparar: comparar, _fluxoNorm: fluxoNorm, _casar: casar };
  document.addEventListener("DOMContentLoaded", wire);
})();
