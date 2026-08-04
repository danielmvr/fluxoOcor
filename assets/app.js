/* =========================================================================
   app.js - Interface do Fluxo de Ocorrencias (fala apenas com window.Store)
   ========================================================================= */
(function () {
  "use strict";
  var Store = window.Store;
  var currentView = "painel";
  var suprimirReset = false;
  var sessaoInicio = Date.now(); // momento em que a ponte/painel abriu (trava alertas retroativos)

  /* ---------------- Helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDur(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return pad(h) + ":" + pad(m) + ":" + pad(s % 60);
  }
  function fmtClock(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDateBR(ymd) {
    if (!ymd) return "";
    if (ymd.indexOf("T") > -1) ymd = ymd.slice(0, 10);
    var p = ymd.split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0].slice(2) : ymd;
  }
  function dataHoje() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  // Momento da quebra: calculado direto de Data da ocorrencia + Hora da quebra (fonte da verdade);
  // cai para inicioEm se a data nao vier. Independe de inicioEm estar preenchido no objeto.
  function quebraTs(o) {
    if (!o || !o.horaQuebra) return null;
    if (o.dataOcorrencia) {
      var ms = Date.parse(o.dataOcorrencia + "T" + o.horaQuebra + ":00");
      if (!isNaN(ms)) return new Date(ms).toISOString();
    }
    return o.inicioEm || null;
  }
  // Linha do tempo com a "Hora da quebra" incluida, ordenada por horario.
  function linhaDoTempo(o) {
    var evs = (o.eventos || []).slice();
    var q = quebraTs(o);
    if (q) evs.push({ ts: q, tipo: "quebra", texto: "Hora da quebra" });
    evs.sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
    return evs;
  }
  function preencherDataHoje() { var el = $("#f-dataOcorrencia"); if (el) el.value = dataHoje(); var td = $("#f-terminoData"); if (td) td.value = dataHoje(); }
  function copiar(texto, btn) {
    function ok() { if (btn) { var t = btn.textContent; btn.textContent = "Copiado!"; setTimeout(function () { btn.textContent = t; }, 1600); } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(ok, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = texto; document.body.appendChild(ta);
      ta.select(); try { document.execCommand("copy"); ok(); } catch (e) { alert("Nao foi possivel copiar."); }
      ta.remove();
    }
  }
  function baixar(conteudo, nome, tipo) {
    var blob = new Blob([conteudo], { type: tipo || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  var escalonadosLocais = {};
  // Checkpoint persistente: o que ESTA maquina ja enviou (sobrevive a reabertura da ponte/aba).
  var ENVIADOS_KEY = "fluxoOcor.enviados.v1";
  var enviadosLog = (function () { try { return JSON.parse(localStorage.getItem(ENVIADOS_KEY) || "{}"); } catch (e) { return {}; } })();
  function jaEnviado(chave) { return !!enviadosLog[chave]; }
  function marcarEnviado(chave) { enviadosLog[chave] = Date.now(); try { localStorage.setItem(ENVIADOS_KEY, JSON.stringify(enviadosLog)); } catch (e) {} }
  function montarDestinos(nomes) {
    var vistos = {}, out = [];
    nomes.forEach(function (nome) {
      nome = (nome || "").trim(); if (!nome) return;
      var chave = nome.toLowerCase(); if (vistos[chave]) return; vistos[chave] = 1;
      out.push({ numero: telGerente(nome), nome: nome });
    });
    return out;
  }
  function postPonte(destinos, mensagem, chave) {
    var cfg = window.WHATSAPP_CONFIG;
    if (!cfg || !cfg.ativo || !cfg.ponteUrl || !destinos || !destinos.length) return Promise.reject(new Error("envio desligado/sem destinos"));
    // chave = identificador estavel do envio (ocorrencia + tipo). A ponte usa p/ ignorar duplicatas.
    return fetch(cfg.ponteUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ destinos: destinos, mensagem: mensagem, chave: chave || "" }) });
  }
  // Roteia o envio: no modo compartilhado (remoto), ENFILEIRA no banco (qualquer maquina);
  // so a maquina com a ponte consome a fila e dispara. No modo local, envia direto.
  function despachar(destinos, mensagem, chave) {
    if (window.MODO === "remoto" && Store.enviarFila) return Store.enviarFila(chave, mensagem, destinos);
    return postPonte(destinos, mensagem, chave);
  }
  // ---- Consumidor da fila: roda SOMENTE na maquina que tem a ponte (PonteWhats) ----
  var EH_PONTE = false, drenandoFila = false, backlogConsumido = false;
  function urlPonteBase() { var cfg = window.WHATSAPP_CONFIG || {}; return (cfg.ponteUrl || "").replace(/enviar\/?$/, ""); }
  function checarPonte() {
    var cfg = window.WHATSAPP_CONFIG || {};
    if (!cfg.ativo || !cfg.ponteUrl) { EH_PONTE = false; return; }
    fetch(urlPonteBase(), { method: "GET" }).then(function (r) { EH_PONTE = !!(r && r.ok); }, function () { EH_PONTE = false; });
  }
  function drenarFila() {
    if (drenandoFila || !EH_PONTE) return;
    if (!(window.MODO === "remoto" && Store.filaPendentes)) return;
    drenandoFila = true;
    // na 1a vez que a ponte abre, "consome" (marca como enviado) tudo que ja estava na fila,
    // SEM enviar -> nao dispara retroativo do que aconteceu antes de a ponte abrir.
    var pre = backlogConsumido ? Promise.resolve(true)
      : Store.consumirBacklog().then(function () { backlogConsumido = true; return true; }, function () { return false; });
    pre.then(function (ok) {
      if (!ok) { drenandoFila = false; return; }
      Store.filaPendentes().then(function (res) {
        var linhas = (res && res.data) ? res.data : [];
        (function proximo(i) {
          if (i >= linhas.length) { drenandoFila = false; return; }
          var row = linhas[i];
          Store.claimEnvio(row.id).then(function (c) {
            if (!(c && c.data && c.data.length)) { proximo(i + 1); return; } // outra aba ja pegou esta linha
            postPonte(row.destinos, row.mensagem, row.chave).then(
              function () { proximo(i + 1); },                                  // enviado
              function () { Store.liberarEnvio(row.id).then(function () { proximo(i + 1); }, function () { proximo(i + 1); }); } // falhou -> libera p/ retry
            );
          }, function () { proximo(i + 1); });
        })(0);
      }, function () { drenandoFila = false; });
    });
  }
  function destinosGrupo() { // grupo do WhatsApp (sempre adicional aos envios individuais)
    var cfg = window.WHATSAPP_CONFIG || {};
    return cfg.grupoId ? [{ grupo: cfg.grupoId, nome: cfg.grupoNome || "Grupo" }] : [];
  }
  function enviarWhats(o) { // na criacao (abertura): Responsavel Apoio do card + grupo
    if (!o) return;
    var chave = o.id + ":abertura";
    if (jaEnviado(chave)) return; // checkpoint: nao reenvia se a ponte reabrir
    despachar(montarDestinos([o.gerenteRegional]).concat(destinosGrupo()), whatsApp(o), chave)
      .then(function () { marcarEnviado(chave); }, function (e) { console.warn("Envio WhatsApp:", e && e.message); });
  }
  // Ao ABRIR uma ocorrencia ja vencida, manda UM unico envio no nivel mais critico
  // (>=3h -> alerta de 3h; >=90min -> aviso de 90min; senao -> abertura normal).
  function enviarNaAbertura(o) {
    if (!o) return;
    var ms = Store.duracaoMs(o);
    if (ms >= 10800000) { marcarEnviado(o.id + ":abertura"); marcarEnviado(o.id + ":90"); escalar(o, "3h"); }
    else if (ms >= 5400000) { marcarEnviado(o.id + ":abertura"); escalar(o, "90"); }
    else { enviarWhats(o); }
  }
  function enviarEncerramento(o) { // ao FINALIZAR a ocorrencia: Responsavel Apoio + grupo
    if (!o) return;
    var chave = o.id + ":fim";
    if (jaEnviado(chave)) return;
    var msg = "✅ *OCORRÊNCIA FINALIZADA*\n\n" + whatsApp(o);
    despachar(montarDestinos([o.gerenteRegional]).concat(destinosGrupo()), msg, chave)
      .then(function () { marcarEnviado(chave); }, function (e) { console.warn("Envio WhatsApp:", e && e.message); });
  }
  // DESATIVADO: envio por atualizacao da linha do tempo. Hoje so enviamos na abertura e nas janelas 90min/3h.
  // (Mantido aqui caso queira reativar no futuro; nenhum lugar chama mais esta funcao.)
  function avisarAtualizacao(id, motivo) {
    var o = Store.obter(id); if (!o) return;
    if (o.status === "finalizada" && motivo !== "Ocorrência finalizada") return; // apos finalizada, so a propria finalizacao avisa
    var ev = (o.eventos && o.eventos.length) ? o.eventos[o.eventos.length - 1] : null;
    var chave = id + ":upd:" + (ev ? ev.ts : motivo);
    if (jaEnviado(chave)) return; // checkpoint: cada atualizacao envia uma unica vez
    var destinos = montarDestinos([o.gerenteRegional]).concat(destinosGrupo());
    if (!destinos.length) return;
    var msg = "🔄 *ATUALIZAÇÃO DA OCORRÊNCIA*" + (motivo ? " — " + motivo : "") + "\n\n" + whatsApp(o);
    despachar(destinos, msg, chave).then(function () { marcarEnviado(chave); }, function (e) { console.warn("Envio WhatsApp:", e && e.message); });
  }
  function responsaveisEmpresa(o) { // regra de escalonamento por empresa
    var emp = empresaDe(o).key;
    if (emp === "REX") return ["Miguel Nazario", "Vinícius Madeira"];
    if (emp === "UTIL" || emp === "SAMP" || emp === "RAF") return ["Thiago Lima", "Jonhatan Sales"];
    return [];
  }
  function jaEscalou(o, nivel) {
    var tipo = nivel === "90" ? "escalado90" : (nivel === "150" ? "escalado150" : "escalado3h");
    return (o.eventos || []).some(function (e) { return e.tipo === tipo; });
  }
  function escalar(o, nivel) {
    var chave = o.id + ":" + nivel;
    if (escalonadosLocais[chave] || jaEnviado(chave)) return; // checkpoint: nao reenvia (sessao + persistente)
    escalonadosLocais[chave] = 1;
    var tipoFlag = nivel === "90" ? "escalado90" : (nivel === "150" ? "escalado150" : "escalado3h");
    // CHECAGEM DUPLA: confirma no banco (fonte da verdade) antes de disparar. Evita alertar
    // um card que ja foi finalizado (ou ja escalado) em outra estacao, mesmo com o cache local velho.
    var confirmar = (window.MODO === "remoto" && Store.lerOcorrenciaDB) ? Store.lerOcorrenciaDB(o.id) : Promise.resolve(o);
    confirmar.then(function (atual) {
      if (window.MODO === "remoto" && !atual) { escalonadosLocais[chave] = 0; return; } // nao confirmou: tenta depois
      var alvo = atual || o;
      if (alvo.status === "finalizada") return;                                  // ja fechada em outra estacao -> NAO dispara
      if ((alvo.eventos || []).some(function (e) { return e.tipo === tipoFlag; })) return; // outra estacao ja escalou
      var mensagem, destinos;
      if (nivel === "90") {
        mensagem = "⚠️ *AVISO: ocorrência com 1h30 (90 min) em aberto*\n\n" + whatsApp(alvo);
        destinos = montarDestinos([alvo.gerenteRegional].concat(responsaveisEmpresa(alvo))); // 90 min: responsavel + gestores (SEM grupo)
      } else if (nivel === "150") {
        mensagem = "⏳ *AVISO AO DIRETOR: ocorrência com 2h30 (150 min) em aberto*\n\n" + whatsApp(alvo);
        destinos = montarDestinos(["Fernando Saiago"]); // 150 min: SOMENTE o diretor
      } else {
        mensagem = "⏰ *ALERTA: ocorrência passou de 3 horas*\n\n" + whatsApp(alvo);
        destinos = montarDestinos([alvo.gerenteRegional].concat(responsaveisEmpresa(alvo)).concat(["Fernando Saiago"])).concat(destinosGrupo()); // 3h: + grupo + diretor
      }
      despachar(destinos, mensagem, chave).then(
        function () { marcarEnviado(chave); Store.marcarEscalado(alvo.id, nivel); },  // enfileirado -> marca (local + linha do tempo)
        function () { escalonadosLocais[chave] = 0; }  // falhou ao enfileirar: libera p/ tentar de novo depois
      );
    }, function () { escalonadosLocais[chave] = 0; }); // erro ao confirmar: tenta depois
  }

  /* ---------------- Navegacao ---------------- */
  function showView(name) {
    currentView = name;
    $all(".view").forEach(function (v) { v.classList.remove("active"); });
    var sec = $("#view-" + name); if (sec) sec.classList.add("active");
    $all(".nav button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === name); });
    if (name === "painel") renderBoard();
    if (name === "nova") preencherDatalists(); // garante seletores atualizados ao abrir o formulario
    if (name === "cadastros") { renderFrota(); renderLoc(); renderPa(); renderGer(); renderLinhas(); }
    if (name === "historico") renderHist();
  }

  /* ---------------- PAINEL ---------------- */
  function statusBadge(st) {
    var s = Store.STATUS[st] || Store.STATUS.aberta;
    return '<span class="status-badge" style="background:' + s.cor + '"><span class="dot"></span>' + esc(s.label) + '</span>';
  }
  /* ---- Empresa (cor) e tipo de carro (formato do onibus) ---- */
  var EMPRESAS = {
    UTIL: { nome: "Util", cor: "#2f6fd0", letra: "U" },
    SAMP: { nome: "Sampaio", cor: "#5cc6ef", letra: "S" },
    RAF:  { nome: "Rapido Federal", cor: "#f2c200", letra: "F" },
    REX:  { nome: "Real Expresso", cor: "#d83a34", letra: "R" }
  };
  var SUFIXO_EMP = { U: "UTIL", S: "SAMP", F: "RAF", R: "REX" };
  function empresaDe(o) {
    var key = (o.regional && EMPRESAS[o.regional]) ? o.regional : null;
    if (!key) { var m = String(o.carro || "").match(/\.([A-Za-z])\s*$/); key = m ? SUFIXO_EMP[m[1].toUpperCase()] : null; }
    return key ? { key: key, nome: EMPRESAS[key].nome, cor: EMPRESAS[key].cor, letra: EMPRESAS[key].letra }
               : { key: "", nome: o.regional || "", cor: "#7d8198", letra: "" };
  }
  function tipoCarro(carro) { var m = String(carro || "").match(/^(\d+)/); return (m && m[1].length >= 5) ? "DD" : "RSD"; }
  function tipoNome(t) { return t === "DD" ? "Double Deck" : "Carro Baixo"; }
  function busSVG(cor, tipo) {
    function r(x, y, w, h, f) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>'; }
    var D = "#11142a", G = "#e4f2ff", T = "#15151f", H = "#8a8fb0", L = "#ffe46b";
    if (tipo === "DD") {
      return '<svg class="bus" viewBox="0 0 40 24" width="46" height="28" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
        r(2,1,36,20,D) + r(3,2,34,18,cor) +
        r(5,3,5,4,G)+r(11,3,5,4,G)+r(17,3,5,4,G)+r(23,3,5,4,G)+r(29,3,4,4,G) +
        r(5,10,5,5,G)+r(11,10,5,5,G)+r(17,10,5,5,G)+r(23,10,4,5,G) +
        r(29,10,7,6,G) + r(36,13,3,4,L) +
        r(7,20,7,4,T)+r(26,20,7,4,T)+r(9,21,3,2,H)+r(28,21,3,2,H) + '</svg>';
    }
    return '<svg class="bus" viewBox="0 0 40 20" width="46" height="24" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      r(2,3,36,13,D) + r(3,4,34,11,cor) +
      r(5,6,5,5,G)+r(11,6,5,5,G)+r(17,6,5,5,G)+r(23,6,4,5,G) +
      r(29,6,7,6,G) + r(36,10,3,4,L) +
      r(7,15,7,4,T)+r(26,15,7,4,T)+r(9,16,3,2,H)+r(28,16,3,2,H) + '</svg>';
  }

  function cronoFreezeMs(o) { return o.socorroEm ? new Date(o.socorroEm).getTime() : (o.finalizadaEm ? new Date(o.finalizadaEm).getTime() : null); }
  function cronoClasse(o) { return (o.socorroEm || o.finalizadaEm) ? "parado" : Store.nivelUrgencia(Store.duracaoMs(o)); }
  function cardHTML(o) {
    var s = Store.STATUS[o.status] || Store.STATUS.aberta;
    var emp = empresaDe(o), tipo = tipoCarro(o.carro);
    var ms = Store.duracaoMs(o);
    var base = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
    var cls = cronoClasse(o), fim = cronoFreezeMs(o);
    var ult = o.eventos && o.eventos.length ? o.eventos[o.eventos.length - 1] : null;
    var opts = Store.STATUS_ATIVOS.map(function (k) {
      return '<option value="' + k + '"' + (k === o.status ? " selected" : "") + '>' + esc(Store.STATUS[k].label) + '</option>';
    }).join("");
    return '' +
      '<div class="card' + (cls === "extremo" ? " extremo" : "") + '" data-id="' + o.id + '">' +
        '<div class="topbar" style="background:' + s.cor + '"></div>' +
        '<div class="body">' +
          '<div class="card-head">' + busSVG(emp.cor, tipo) +
            '<div class="card-head-txt">' +
              '<p class="carro"><span class="cod">' + esc(o.carro || "?") + '</span>' + (o.carroSegue ? '<span class="segue">&rarr; ' + esc(o.carroSegue) + '</span>' : '') + '</p>' +
              '<p class="empresa">' + esc(emp.nome) + (emp.nome ? ' &middot; ' + tipoNome(tipo) : '') + '</p>' +
            '</div>' +
          '</div>' +
          '<p class="linha">' + esc(o.linha || "linha nao informada") + (o.horarioViagem ? ' &middot; serv. ' + esc(o.horarioViagem) : '') + '</p>' +
          '<div class="crono ' + cls + '" data-aberta="' + base + '"' + (fim ? ' data-fim="' + fim + '"' : '') + '>' + fmtDur(ms) + '</div>' +
          '<p class="row">' + statusBadge(o.status) + '</p>' +
          '<p class="row"><b>Local:</b> ' + esc(o.localSocorro || "-") + '</p>' +
          '<p class="row"><b>Motorista:</b> ' + esc(o.motorista || "-") + '</p>' +
          (o.defeitoMotorista ? '<p class="row"><b>Defeito:</b> ' + esc(o.defeitoMotorista) + '</p>' : '') +
          '<div class="card-actions">' +
            '<select class="status-sel" data-id="' + o.id + '" title="Mudar status">' + opts + '</select>' +
            '<button class="btn blue sm" data-action="detalhe" data-id="' + o.id + '">Detalhes</button>' +
            '<button class="btn yellow sm" data-action="copiar" data-id="' + o.id + '">Copiar p/Whats</button>' +
            (o.socorroEm ? '' : '<button class="btn sos sm" data-action="sos" data-id="' + o.id + '">Finalizar S.O.S. Passageiros</button>') +
            '<button class="btn green sm" data-action="finalizar" data-id="' + o.id + '">Finalizar</button>' +
          '</div>' +
          (ult ? '<div class="last-event"><b>' + fmtClock(ult.ts) + '</b> ' + esc(ult.texto) + '</div>' : '') +
        '</div>' +
      '</div>';
  }
  function renderBoard() {
    var board = $("#board");
    var termo = ($("#buscaPainel").value || "").toLowerCase();
    var fstatus = $("#filtroStatus").value;
    var empSel = $all("#filtroEmpresa input:checked").map(function (c) { return c.value; });
    var lista = Store.listarAtivas().filter(function (o) {
      if (fstatus && o.status !== fstatus) return false;
      if (empSel.length && empSel.indexOf(empresaDe(o).key) === -1) return false;
      if (!termo) return true;
      return [o.carro, o.carroSegue, o.linha, o.motorista, o.localSocorro, o.coordenador]
        .join(" ").toLowerCase().indexOf(termo) > -1;
    });
    lista.sort(function (a, b) { return Store.duracaoMs(b) - Store.duracaoMs(a); }); // maior duracao primeiro
    $("#badgeAtivas").textContent = Store.listarAtivas().length;
    if (!lista.length) {
      board.innerHTML = '<div class="empty">Nenhuma ocorrencia em andamento.<br>Clique em "+ Nova" para abrir.</div>';
      return;
    }
    board.innerHTML = lista.map(cardHTML).join("");
  }
  function tick() {
    var rel = $("#relogio"); if (rel) { var dn = new Date(); rel.textContent = pad(dn.getHours()) + ":" + pad(dn.getMinutes()) + ":" + pad(dn.getSeconds()); }
    var pc = $("#pbCount"); if (pc) pc.textContent = Store.listarAtivas().length;
    $all(".crono[data-aberta]").forEach(function (c) {
      var aberta = Number(c.getAttribute("data-aberta"));
      var fimAttr = c.getAttribute("data-fim");
      var ms = (fimAttr ? Number(fimAttr) : Date.now()) - aberta;
      c.textContent = fmtDur(ms);
      if (fimAttr) return; // parado (S.O.S./finalizado): mantem a classe
      var urg = Store.nivelUrgencia(ms);
      c.classList.remove("ok", "atencao", "critico", "extremo"); c.classList.add(urg);
      var card = c.closest ? c.closest(".card") : null;
      if (card) card.classList.toggle("extremo", urg === "extremo");
    });
    $all(".dur-sec[data-aberta]").forEach(function (c) {
      var ab = Number(c.getAttribute("data-aberta")), f = c.getAttribute("data-fim");
      c.textContent = fmtDur((f ? Number(f) : Date.now()) - ab);
    });
    // Escalonamento automatico: 90 min -> responsavel + empresa; 150 min -> SO diretor; 3h -> todos + grupo + diretor.
    // Trava: so dispara se o criterio for atingido DEPOIS que a ponte/painel abriu
    // (nao reenvia retroativo do que ja tinha passado antes de abrir).
    Store.listarAtivas().forEach(function (o) {
      var ms = Store.duracaoMs(o);
      var base = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
      if (ms >= 10800000) { if (!jaEscalou(o, "3h") && base + 10800000 >= sessaoInicio) escalar(o, "3h"); }
      else if (ms >= 9000000) { if (!jaEscalou(o, "150") && base + 9000000 >= sessaoInicio) escalar(o, "150"); }
      else if (ms >= 5400000) { if (!jaEscalou(o, "90") && base + 5400000 >= sessaoInicio) escalar(o, "90"); }
    });
  }

  /* ---------------- NOVA / EDICAO ---------------- */
  function preencherDatalists() {
    $("#frotaList").innerHTML = Store.frota().map(function (v) {
      return '<option value="' + esc(v.veiculo) + '">' + esc(v.modelo + " | " + v.regional) + '</option>';
    }).join("");
    // preserva o que estiver selecionado ao reconstruir (evita perder a escolha em atualizacoes ao vivo)
    var gEl = $("#f-gerente"), mEl = $("#f-manutencao"), lEl = $("#f-linha"), fsEl = $("#filtroStatus");
    var gVal = gEl ? gEl.value : "", mVal = mEl ? mEl.value : "", lVal = lEl ? lEl.value : "", fsVal = fsEl ? fsEl.value : "";
    var gers = Store.gerentes().slice().sort(function (a, b) { return (a.nome || "").localeCompare(b.nome || "", "pt-BR", { sensitivity: "base" }); });
    var respOpts = '<option value="">-</option>' + gers.map(function (g) {
      return '<option value="' + esc(g.nome) + '"' + (g.telefone ? ' style="font-weight:bold"' : '') + '>' + esc(g.nome) + '</option>';
    }).join("");
    if (gEl) { gEl.innerHTML = respOpts; gEl.value = gVal; }
    if (mEl) { mEl.innerHTML = respOpts; mEl.value = mVal; }
    var lins = Store.linhas().slice().sort(function (a, b) { return String(a).localeCompare(String(b), "pt-BR", { sensitivity: "base", numeric: true }); });
    if (lEl) { lEl.innerHTML = '<option value="">-</option>' + lins.map(function (l) {
      return '<option value="' + esc(l) + '">' + esc(l) + '</option>';
    }).join(""); lEl.value = lVal; }
    if (fsEl) { fsEl.innerHTML = '<option value="">Todos os status</option>' + Store.STATUS_ATIVOS.map(function (k) {
      return '<option value="' + k + '">' + esc(Store.STATUS[k].label) + '</option>';
    }).join(""); fsEl.value = fsVal; }
  }
  function onCarro() {
    var v = Store.buscarVeiculo($("#f-carro").value);
    $("#veicInfo").textContent = v ? (v.modelo + " | " + v.regional + " | placa " + (v.placa || "?") + " | " + (v.capacidade || 0) + " lug.") : "";
  }
  function lerForm() {
    var f = $("#form-ocorrencia"), d = {};
    $all("input, textarea, select", f).forEach(function (el) {
      if (el.type === "radio") { if (el.checked) d[el.name] = el.value; }
      else if (el.name) d[el.name] = el.value.trim();
    });
    return d;
  }
  function editar(o) {
    var f = $("#form-ocorrencia");
    suprimirReset = true; f.reset(); suprimirReset = false;
    Object.keys(o).forEach(function (k) {
      var el = f.elements[k]; if (!el) return;
      if (el.length && el[0] && el[0].type === "radio") {
        $all('input[name="' + k + '"]', f).forEach(function (r) { r.checked = (r.value === o[k]); });
      } else if (el.type === "radio") {
        $all('input[name="' + k + '"]', f).forEach(function (r) { r.checked = (r.value === o[k]); });
      } else { el.value = o[k] == null ? "" : o[k]; }
    });
    $("#f-id").value = o.id;
    var travado = !(o.finalizadaEm || o.socorroEm);
    var tEl = $("#f-termino"); if (tEl) tEl.disabled = travado;
    var tdEl = $("#f-terminoData"); if (tdEl) tdEl.disabled = travado;
    $("#cancelarEdicao").style.display = "";
    onCarro();
    showView("nova");
  }

  /* ---------------- MODAL DETALHE ---------------- */
  function telGerente(nome) { if (!nome) return ""; var g = Store.gerentes().filter(function (x) { return x.nome === nome; })[0]; return g && g.telefone ? g.telefone : ""; }
  function whatsApp(o) {
    var emp = empresaDe(o), tipo = tipoCarro(o.carro);
    var DIV = "━━━━━━━━━━━━━━━━";
    var L = [];
    L.push("🚨 *OCORRÊNCIA - SOCORRO* 🚨");
    // ---------- Dados do serviço ----------
    L.push(DIV);
    L.push("🧾 *DADOS DO SERVIÇO*");
    L.push("🚌 Carro: *" + (o.carro || "-") + "*" + (o.carroSegue ? "   ➡️ segue: *" + o.carroSegue + "*" : ""));
    if (emp.nome) L.push("🏢 Empresa: " + emp.nome + " · " + tipoNome(tipo));
    if (o.servico) L.push("🔖 Serviço: " + o.servico);
    if (o.linha) L.push("🧭 Linha: " + o.linha);
    if (o.dataViagem) L.push("🗓️ Data da viagem: " + fmtDateBR(o.dataViagem));
    if (o.horarioViagem) L.push("⏰ Horário da viagem: " + o.horarioViagem);
    if (o.motorista) L.push("👤 Motorista: " + o.motorista + (o.matricula ? " (mat " + o.matricula + ")" : ""));
    // ---------- Dados da ocorrência ----------
    L.push(DIV);
    L.push("⚠️ *DADOS DA OCORRÊNCIA*");
    if (o.dataOcorrencia) L.push("📅 Data da ocorrência: " + fmtDateBR(o.dataOcorrencia));
    if (o.horaQuebra) L.push("🛠️ Hora da quebra: " + o.horaQuebra);
    if (o.localSocorro) L.push("📍 Local: " + o.localSocorro);
    if (o.defeitoMotorista) L.push("🔧 Defeito: " + o.defeitoMotorista);
    if (o.responsavelManutencao) L.push("🧰 Manutenção: " + o.responsavelManutencao);
    if (o.saidaSocorro) L.push("🚐 Saída do socorro: " + o.saidaSocorro);
    if (o.terminoSocorro) L.push("🏁 Término do socorro: " + o.terminoSocorro + (o.terminoData ? " (" + fmtDateBR(o.terminoData) + ")" : ""));
    L.push("👥 Clientes: " + (o.qtdClientes || "0") + "   📦 Encomendas: " + (o.encomendas || "-") + "   🍽️ Alimentação: " + (o.alimentacaoFornecida || "-"));
    if (o.gerenteRegional) L.push("👔 Responsável Apoio: " + o.gerenteRegional + (telGerente(o.gerenteRegional) ? " (" + telGerente(o.gerenteRegional) + ")" : ""));
    if (o.coordenador) L.push("🧑‍💼 Coordenador: " + o.coordenador);
    // ---------- Status / duração ----------
    L.push(DIV);
    L.push("⏱️ Status: *" + (Store.STATUS[o.status] ? Store.STATUS[o.status].label : o.status) + "*   ·   Duração: *" + fmtDur(Store.duracaoMs(o)) + "*" + (o.status === "finalizada" ? " (final)" : " (em curso)"));
    if (o.socorroEm && Store.duracaoSecundariaMs) L.push("🔧 Duração SOS Mecânico: *" + fmtDur(Store.duracaoSecundariaMs(o)) + "*");
    if (o.obs) L.push("📝 Obs: " + o.obs);
    if (o.eventos && o.eventos.length) {
      L.push(DIV);
      L.push("🕒 *Linha do tempo*");
      linhaDoTempo(o).forEach(function (e) { L.push("• " + fmtClock(e.ts) + " — " + (e.texto || "")); });
    }
    return L.join("\n");
  }
  function abrirDetalhe(id) {
    var o = Store.obter(id); if (!o) return;
    var empM = empresaDe(o), tipoM = tipoCarro(o.carro);
    $("#m-titulo").innerHTML = busSVG(empM.cor, tipoM) + " Carro " + esc(o.carro || "?");
    $("#m-status").innerHTML = statusBadge(o.status) + ' <span style="color:#bbb;font-size:10px">' + esc(empM.nome) + " &middot; " + tipoNome(tipoM) + "</span>";
    function blocoDet(titulo, pares) {
      var corpo = pares.filter(function (p) { return p[1]; }).map(function (p) {
        return '<p class="row"><b>' + esc(p[0]) + ':</b> ' + esc(p[1]) + '</p>';
      }).join("");
      return corpo ? ('<p style="margin:12px 0 5px;font-weight:700;color:#9c2742;font-size:13px;border-bottom:2px solid #ddd6c2;padding-bottom:3px">' + titulo + '</p>' + corpo) : '';
    }
    var info =
      blocoDet("Dados do serviço", [
        ["Servico", o.servico], ["Horario da viagem", o.horarioViagem],
        ["Linha", o.linha], ["Data da viagem", fmtDateBR(o.dataViagem)],
        ["Motorista", o.motorista], ["Matricula", o.matricula],
        ["Placa", o.placa], ["Carro que segue", o.carroSegue], ["Regional", o.regional]
      ]) +
      blocoDet("Dados da ocorrência", [
        ["Data da ocorrencia", fmtDateBR(o.dataOcorrencia)], ["Hora da quebra", o.horaQuebra],
        ["Local", o.localSocorro], ["Defeito", o.defeitoMotorista],
        ["Manutencao acionada", o.responsavelManutencao], ["Saida do socorro", o.saidaSocorro],
        ["Termino do socorro", o.terminoSocorro], ["Data do termino", fmtDateBR(o.terminoData)],
        ["Qtd. clientes", o.qtdClientes], ["Encomendas", o.encomendas],
        ["Alimentacao", o.alimentacaoFornecida], ["Responsavel Apoio", o.gerenteRegional],
        ["Coordenador", o.coordenador], ["Obs", o.obs]
      ]);

    var stBtns = Store.STATUS_ATIVOS.map(function (k) {
      return '<button class="btn sm" data-action="m-status" data-id="' + o.id + '" data-status="' + k + '" style="background:' + Store.STATUS[k].cor + '">' + esc(Store.STATUS[k].label) + '</button>';
    }).join(" ");

    var timeline = linhaDoTempo(o).reverse().map(function (e) {
      return '<li><span class="t">' + fmtClock(e.ts) + '</span><br>' + esc(e.texto) + '</li>';
    }).join("");

    var baseMs = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
    var durSecMs = Store.duracaoSecundariaMs ? Store.duracaoSecundariaMs(o) : null;
    var secHTML = o.socorroEm
      ? '<p class="row" style="text-align:center;color:#9aa;font-size:13px;margin-top:-4px">Duração SOS Mecânico: <b class="dur-sec" data-aberta="' + baseMs + '"' + (o.finalizadaEm ? ' data-fim="' + new Date(o.finalizadaEm).getTime() + '"' : '') + '>' + fmtDur(durSecMs == null ? 0 : durSecMs) + '</b></p>'
      : '';
    $("#m-body").innerHTML =
      '<div class="crono ' + cronoClasse(o) + '" data-aberta="' + baseMs + '"' + (cronoFreezeMs(o) ? ' data-fim="' + cronoFreezeMs(o) + '"' : '') + '>' + fmtDur(Store.duracaoMs(o)) + '</div>' +
      secHTML +
      '<p class="row" style="text-align:center;color:#888;font-size:12px">Quebra: ' + (o.horaQuebra ? (fmtDateBR(o.dataOcorrencia) + " " + o.horaQuebra) : fmtClock(o.abertaEm)) + (o.terminoSocorro ? " | Termino: " + (o.terminoData ? fmtDateBR(o.terminoData) + " " : "") + o.terminoSocorro : "") + (o.finalizadaEm ? " | Finalizada: " + fmtClock(o.finalizadaEm) : "") + '</p>' +
      info +
      '<label>Mudar status</label><div style="display:flex;gap:6px;flex-wrap:wrap">' + stBtns + '</div>' +
      '<label>Registrar medida / atualizacao</label>' +
      '<div style="display:flex;gap:6px"><input type="text" id="m-evento" placeholder="Ex.: socorro saiu de RIO 08:52"><button class="btn green sm" data-action="m-add" data-id="' + o.id + '">Adicionar</button></div>' +
      '<label>Linha do tempo</label><ul class="timeline">' + (timeline || "<li>Sem eventos.</li>") + "</ul>" +
      '<div class="form-actions">' +
        (o.status === "finalizada"
          ? '<button class="btn yellow sm" data-action="m-reabrir" data-id="' + o.id + '">Reabrir</button>'
          : ((o.socorroEm ? '' : '<button class="btn sos sm" data-action="m-sos" data-id="' + o.id + '">Finalizar S.O.S. Passageiros</button>') +
             '<button class="btn green sm" data-action="m-finalizar" data-id="' + o.id + '">Finalizar</button>')) +
        '<button class="btn blue sm" data-action="m-copiar" data-id="' + o.id + '">Copiar p/Whats</button>' +
        '<button class="btn ghost sm" data-action="m-editar" data-id="' + o.id + '">Editar</button>' +
        '<button class="btn wine sm" data-action="m-excluir" data-id="' + o.id + '">Excluir</button>' +
      '</div>';
    $("#overlay").classList.add("open");
  }
  function fecharModal() { $("#overlay").classList.remove("open"); }

  /* ---------------- CADASTROS ---------------- */
  function renderFrota() {
    var termo = ($("#buscaFrota").value || "").toLowerCase();
    var lista = Store.frota().filter(function (v) {
      return !termo || [v.veiculo, v.placa, v.regional, v.modelo, v.nop].join(" ").toLowerCase().indexOf(termo) > -1;
    });
    $("#frotaCount").textContent = lista.length + " / " + Store.frota().length + " veiculos";
    var rows = lista.slice(0, 600).map(function (v) {
      return "<tr><td>" + esc(v.veiculo) + "</td><td>" + esc(v.modelo) + "</td><td>" + esc(v.regional) +
        "</td><td>" + esc(v.placa) + "</td><td>" + esc(v.uf) + "</td><td>" + esc(v.capacidade) + "</td><td>" + esc(v.ano) + "</td></tr>";
    }).join("");
    $("#tblFrota").innerHTML = "<thead><tr><th>Carro</th><th>Modelo</th><th>Regional</th><th>Placa</th><th>UF</th><th>Cap.</th><th>Ano</th></tr></thead><tbody>" + rows + "</tbody>";
  }
  function renderLoc() {
    var termo = (($("#buscaLoc") || {}).value || "").toLowerCase();
    var all = Store.localidades();
    var rows = all.map(function (l, i) { return { l: l, i: i }; })
      .filter(function (o) { return !termo || [o.l.sigla, o.l.nome, o.l.uf].join(" ").toLowerCase().indexOf(termo) > -1; })
      .map(function (o) {
        return "<tr><td>" + esc(o.l.sigla) + "</td><td>" + esc(o.l.nome) + "</td><td>" + esc(o.l.uf || "") +
          '</td><td><button class="btn wine sm" data-action="loc-del" data-i="' + o.i + '">x</button></td></tr>';
      }).join("");
    var c = $("#locCount"); if (c) c.textContent = all.length + " siglas";
    $("#tblLoc").innerHTML = "<thead><tr><th>Sigla</th><th>Nome</th><th>UF</th><th></th></tr></thead><tbody>" + rows + "</tbody>";
  }
  function renderPa() {
    var termo = (($("#buscaPa") || {}).value || "").toLowerCase();
    var all = Store.pontosApoio();
    var rows = all.map(function (p, i) { return { p: p, i: i }; })
      .filter(function (o) { return !termo || [o.p.nome, o.p.sigla, o.p.tipo, o.p.obs].join(" ").toLowerCase().indexOf(termo) > -1; })
      .map(function (o) {
        var p = o.p;
        return "<tr><td>" + esc(p.nome) + "</td><td>" + esc(p.sigla || "") + "</td><td>" + esc(p.tipo || "") +
          "</td><td>" + esc(p.obs || "") + '</td><td><button class="btn wine sm" data-action="pa-del" data-i="' + o.i + '">x</button></td></tr>';
      }).join("");
    var c = $("#paCount"); if (c) c.textContent = all.length + " pontos";
    $("#tblPa").innerHTML = "<thead><tr><th>Nome</th><th>Sigla</th><th>Tipo</th><th>Obs</th><th></th></tr></thead><tbody>" + rows + "</tbody>";
  }

  function renderGer() {
    var all = Store.gerentes();
    var rows = all.map(function (g, i) {
      return "<tr><td>" + esc(g.nome) + "</td><td>" + esc(g.telefone || "") +
        '</td><td><button class="btn ghost sm" data-action="ger-edit" data-i="' + i + '">editar</button> ' +
        '<button class="btn wine sm" data-action="ger-del" data-nome="' + esc(g.nome) + '">x</button></td></tr>';
    }).join("");
    var c = $("#gerCount"); if (c) c.textContent = all.length + " responsaveis";
    $("#tblGer").innerHTML = "<thead><tr><th>Responsavel</th><th>Telefone</th><th></th></tr></thead><tbody>" + rows + "</tbody>";
  }
  function renderLinhas() {
    var termo = (($("#buscaLinha") || {}).value || "").toLowerCase();
    var all = Store.linhas();
    var rows = all.map(function (l, i) { return { l: l, i: i }; })
      .filter(function (o) { return !termo || o.l.toLowerCase().indexOf(termo) > -1; })
      .map(function (o) {
        return "<tr><td>" + esc(o.l) + '</td><td><button class="btn wine sm" data-action="linha-del" data-i="' + o.i + '">x</button></td></tr>';
      }).join("");
    var c = $("#linhaCount"); if (c) c.textContent = all.length + " linhas";
    $("#tblLinhas").innerHTML = "<thead><tr><th>Linha</th><th></th></tr></thead><tbody>" + rows + "</tbody>";
  }

  /* ---------------- HISTORICO ---------------- */
  var CSV_COLS = ["abertaEm", "dataOcorrencia", "horaQuebra", "terminoSocorro", "terminoData", "servico", "finalizadaEm", "carro", "carroSegue", "motorista", "matricula", "linha",
    "localSocorro", "regional", "defeitoMotorista", "responsavelManutencao", "saidaSocorro",
    "encomendas", "alimentacaoFornecida", "qtdClientes", "gerenteRegional", "coordenador", "obs", "status"];
  function ymdISO(iso) { if (!iso) return ""; var d = new Date(iso); if (isNaN(d)) return ""; return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function histFiltradas() {
    var termo = ($("#buscaHist").value || "").toLowerCase();
    var empSel = $all("#histEmpresa input:checked").map(function (c) { return c.value; });
    var de = (($("#histDe") || {}).value) || "";
    var ate = (($("#histAte") || {}).value) || "";
    return Store.listarFinalizadas().filter(function (o) {
      if (empSel.length && empSel.indexOf(empresaDe(o).key) === -1) return false;
      var dOco = o.dataOcorrencia || ymdISO(o.abertaEm);
      if (de && (!dOco || dOco < de)) return false;
      if (ate && (!dOco || dOco > ate)) return false;
      return !termo || [o.carro, o.linha, o.motorista, o.localSocorro, o.coordenador].join(" ").toLowerCase().indexOf(termo) > -1;
    });
  }
  function renderHist() {
    var lista = histFiltradas();
    var rows = lista.map(function (o) {
      var sec = (o.socorroEm && Store.duracaoSecundariaMs) ? fmtDur(Store.duracaoSecundariaMs(o)) : "-";
      return "<tr><td>" + fmtClock(o.abertaEm) + "</td><td>" + esc(o.carro) + "</td><td>" + esc(o.linha) +
        "</td><td>" + esc(o.localSocorro) + "</td><td>" + fmtDur(Store.duracaoMs(o)) + "</td><td>" + sec +
        '</td><td><button class="btn blue sm" data-action="detalhe" data-id="' + o.id + '">Ver</button> ' +
        '<button class="btn wine sm" data-action="hist-del" data-id="' + o.id + '">x</button></td></tr>';
    }).join("");
    $("#tblHist").innerHTML = "<thead><tr><th>Aberta</th><th>Carro</th><th>Linha</th><th>Local</th><th>Duracao</th><th>Dur. SOS Mec.</th><th></th></tr></thead><tbody>" +
      (rows || '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px">Nenhuma ocorrencia finalizada ainda.</td></tr>') + "</tbody>";
  }
  function exportarCSV() {
    var lista = histFiltradas(); if (!lista.length) { alert("Nada para exportar (com os filtros atuais)."); return; }
    function cell(v) { v = String(v == null ? "" : v).replace(/"/g, '""'); return /[",\n;]/.test(v) ? '"' + v + '"' : v; }
    var linhas = [CSV_COLS.concat(["duracao", "duracao_sos_mecanico"]).join(";")];
    lista.forEach(function (o) {
      var row = CSV_COLS.map(function (c) {
        if (c === "abertaEm" || c === "finalizadaEm") return cell(fmtClock(o[c]));
        return cell(o[c]);
      });
      row.push(cell(fmtDur(Store.duracaoMs(o))));
      row.push(cell((o.socorroEm && Store.duracaoSecundariaMs) ? fmtDur(Store.duracaoSecundariaMs(o)) : ""));
      linhas.push(row.join(";"));
    });
    baixar(linhas.join("\n"), "ocorrencias_" + new Date().toISOString().slice(0, 10) + ".csv", "text/csv;charset=utf-8");
  }

  /* ---------------- IMPORTACOES ---------------- */
  function parseCSV(texto) {
    var sep = (texto.split("\n")[0].indexOf(";") > -1) ? ";" : ",";
    var linhas = texto.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim(); });
    if (!linhas.length) return [];
    var head = linhas.shift().split(sep).map(function (h) { return h.trim(); });
    return linhas.map(function (l) {
      var cols = l.split(sep), obj = {};
      head.forEach(function (h, i) { obj[h] = (cols[i] || "").trim(); });
      return obj;
    });
  }
  function parseKML(texto) {
    var doc = new DOMParser().parseFromString(texto, "text/xml");
    var pms = doc.getElementsByTagName("Placemark"), out = [];
    for (var i = 0; i < pms.length; i++) {
      var nm = pms[i].getElementsByTagName("name")[0];
      var co = pms[i].getElementsByTagName("coordinates")[0];
      var de = pms[i].getElementsByTagName("description")[0];
      if (!co) continue; // so pontos
      var c = co.textContent.trim().split(/\s+/)[0].split(",");
      out.push({ nome: nm ? nm.textContent.trim() : "", lon: c[0], lat: c[1], desc: de ? de.textContent.trim() : "" });
    }
    return out;
  }
  function lerArquivo(file, cb) { var fr = new FileReader(); fr.onload = function () { cb(fr.result); }; fr.readAsText(file, "utf-8"); }
  function guessSigla(nome) {
    var m = (nome || "").match(/^([A-Z]{2,4})\b/); return m ? m[1] : "";
  }

  /* ---------------- Eventos globais ---------------- */
  function wire() {
    // navegacao
    $all(".nav button").forEach(function (b) { b.addEventListener("click", function () { showView(b.getAttribute("data-view")); }); });
    // subtabs
    $all(".sub").forEach(function (b) {
      b.addEventListener("click", function () {
        $all(".sub").forEach(function (x) { x.classList.remove("active"); }); b.classList.add("active");
        var s = b.getAttribute("data-sub");
        $("#sub-frota").style.display = s === "frota" ? "" : "none";
        $("#sub-localidades").style.display = s === "localidades" ? "" : "none";
        $("#sub-pontos").style.display = s === "pontos" ? "" : "none";
        $("#sub-gerentes").style.display = s === "gerentes" ? "" : "none";
        $("#sub-linhas").style.display = s === "linhas" ? "" : "none";
      });
    });
    // buscas
    $("#buscaPainel").addEventListener("input", renderBoard);
    $("#filtroStatus").addEventListener("change", renderBoard);
    var fe = $("#filtroEmpresa"); if (fe) fe.addEventListener("change", renderBoard);
    $("#buscaFrota").addEventListener("input", renderFrota);
    $("#buscaHist").addEventListener("input", renderHist);
    var he = $("#histEmpresa"); if (he) he.addEventListener("change", renderHist);
    var hd = $("#histDe"); if (hd) hd.addEventListener("change", renderHist);
    var ha = $("#histAte"); if (ha) ha.addEventListener("change", renderHist);
    var hl = $("#histLimpar"); if (hl) hl.addEventListener("click", function () {
      if (hd) hd.value = ""; if (ha) ha.value = "";
      $all("#histEmpresa input:checked").forEach(function (c) { c.checked = false; });
      var bh = $("#buscaHist"); if (bh) bh.value = "";
      renderHist();
    });
    $("#buscaLoc").addEventListener("input", renderLoc);
    $("#buscaPa").addEventListener("input", renderPa);
    // carro -> info
    $("#f-carro").addEventListener("input", onCarro);
    // form submit
    $("#form-ocorrencia").addEventListener("submit", function (e) {
      e.preventDefault();
      var d = lerForm();
      if (!d.carro) { alert("Informe o carro."); return; }
      if (d.id) { Store.atualizar(d.id, d); } else { delete d.id; var novo = Store.criar(d); enviarNaAbertura(novo); }
      e.target.reset(); preencherDataHoje(); $("#f-termino").disabled = true; $("#f-terminoData").disabled = true; $("#f-id").value = ""; $("#veicInfo").textContent = ""; $("#cancelarEdicao").style.display = "none";
      showView("painel");
    });
    $("#form-ocorrencia").addEventListener("reset", function () { if (suprimirReset) return; setTimeout(function () { preencherDataHoje(); $("#f-termino").disabled = true; $("#f-terminoData").disabled = true; }, 0); });
    $("#cancelarEdicao").addEventListener("click", function () {
      $("#form-ocorrencia").reset(); preencherDataHoje(); $("#f-termino").disabled = true; $("#f-terminoData").disabled = true; $("#f-id").value = ""; $("#cancelarEdicao").style.display = "none"; showView("painel");
    });
    // status select (delegacao change)
    document.addEventListener("change", function (e) {
      var sel = e.target.closest(".status-sel"); if (!sel) return;
      Store.mudarStatus(sel.getAttribute("data-id"), sel.value); renderBoard();
    });
    // cadastros add
    $("#addLoc").addEventListener("click", function () {
      var s = $("#loc-sigla").value.trim(), n = $("#loc-nome").value.trim();
      if (!s && !n) return;
      var arr = Store.localidades(); arr.push({ sigla: s.toUpperCase(), nome: n, uf: $("#loc-uf").value.trim().toUpperCase() });
      Store.salvarLocalidades(arr); $("#loc-sigla").value = $("#loc-nome").value = $("#loc-uf").value = ""; renderLoc();
    });
    $("#addPa").addEventListener("click", function () {
      var n = $("#pa-nome").value.trim(); if (!n) return;
      var arr = Store.pontosApoio(); arr.push({ nome: n, sigla: $("#pa-sigla").value.trim().toUpperCase(), tipo: $("#pa-tipo").value.trim(), obs: "" });
      Store.salvarPontosApoio(arr); $("#pa-nome").value = $("#pa-sigla").value = $("#pa-tipo").value = ""; renderPa();
    });
    $("#addGer").addEventListener("click", function () {
      var n = $("#ger-nome").value.trim(); if (!n) return;
      Store.salvarGerente({ nome: n, telefone: $("#ger-tel").value.trim() });
      $("#ger-nome").value = $("#ger-tel").value = ""; renderGer(); preencherDatalists();
    });
    $("#addLinha").addEventListener("click", function () {
      var n = $("#linha-nova").value.trim(); if (!n) return;
      var arr = Store.linhas(); if (arr.indexOf(n) === -1) arr.push(n);
      Store.salvarLinhas(arr); $("#linha-nova").value = ""; renderLinhas(); preencherDatalists();
    });
    $("#buscaLinha").addEventListener("input", renderLinhas);
    // imports
    $("#impFrota").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      lerArquivo(f, function (txt) {
        try {
          var arr = f.name.match(/\.json$/i) ? JSON.parse(txt) : parseCSV(txt);
          arr = arr.map(function (r) {
            return { veiculo: r.veiculo || r["Veículo"] || r.carro, modelo: r.modelo || r.Frota || "", capacidade: r.capacidade || r["Capacidade Pax"] || 0,
              regional: r.regional || r.Regional || "", nop: r.nop || r.NOp || "", placa: r.placa || r.Placa || "", uf: r.uf || "", ano: r.ano || "" };
          }).filter(function (r) { return r.veiculo; });
          if (arr.length) { Store.salvarFrota(arr); preencherDatalists(); renderFrota(); alert(arr.length + " veiculos importados."); }
          else alert("Nenhum veiculo reconhecido no arquivo.");
        } catch (err) { alert("Falha ao ler: " + err.message); }
      });
      this.value = "";
    });
    $("#impLoc").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      lerArquivo(f, function (txt) {
        try {
          var arr;
          if (f.name.match(/\.kml$/i)) arr = parseKML(txt).map(function (p) { return { sigla: guessSigla(p.nome), nome: p.nome, uf: "" }; });
          else if (f.name.match(/\.json$/i)) arr = JSON.parse(txt);
          else arr = parseCSV(txt).map(function (r) { return { sigla: (r.sigla || "").toUpperCase(), nome: r.nome || r.name || "", uf: (r.uf || "").toUpperCase() }; });
          var atual = Store.localidades().concat(arr.filter(function (x) { return x.nome || x.sigla; }));
          Store.salvarLocalidades(atual); renderLoc(); alert(arr.length + " localidades importadas.");
        } catch (err) { alert("Falha ao ler: " + err.message); }
      });
      this.value = "";
    });
    $("#impPa").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      lerArquivo(f, function (txt) {
        try {
          var arr;
          if (f.name.match(/\.kml$/i)) arr = parseKML(txt).map(function (p) { return { nome: p.nome, sigla: "", tipo: "", obs: (p.desc || "") + (p.lat ? " (" + p.lat + "," + p.lon + ")" : "") }; });
          else if (f.name.match(/\.json$/i)) arr = JSON.parse(txt);
          else arr = parseCSV(txt).map(function (r) { return { nome: r.nome || r.name || "", sigla: (r.sigla || "").toUpperCase(), tipo: r.tipo || "", obs: r.obs || "" }; });
          var atual = Store.pontosApoio().concat(arr.filter(function (x) { return x.nome; }));
          Store.salvarPontosApoio(atual); renderPa(); alert(arr.length + " pontos importados.");
        } catch (err) { alert("Falha ao ler: " + err.message); }
      });
      this.value = "";
    });
    // historico export/backup
    $("#expCSV").addEventListener("click", exportarCSV);
    $("#expJSON").addEventListener("click", function () {
      var lista = histFiltradas(); if (!lista.length) { alert("Nada para exportar (com os filtros atuais)."); return; }
      baixar(JSON.stringify(lista, null, 2), "ocorrencias_" + new Date().toISOString().slice(0, 10) + ".json", "application/json");
    });
    $("#backup").addEventListener("click", function () {
      baixar(Store.exportarTudo(), "backup_fluxo_" + new Date().toISOString().slice(0, 10) + ".json", "application/json");
    });
    $("#restore").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      if (!confirm("Restaurar substitui TODOS os dados atuais. Continuar?")) { this.value = ""; return; }
      lerArquivo(f, function (txt) {
        try { Store.importarTudo(txt); preencherDatalists(); showView("painel"); alert("Backup restaurado."); }
        catch (err) { alert("Arquivo invalido: " + err.message); }
      });
      this.value = "";
    });
    // modal fechar
    $("#m-fechar").addEventListener("click", fecharModal);
    $("#overlay").addEventListener("click", function (e) { if (e.target === $("#overlay")) fecharModal(); });

    // delegacao de acoes (cliques)
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-action]"); if (!t) return;
      var a = t.getAttribute("data-action"), id = t.getAttribute("data-id"), i = t.getAttribute("data-i");
      switch (a) {
        case "detalhe": abrirDetalhe(id); break;
        case "copiar": copiar(whatsApp(Store.obter(id)), t); break;
        case "finalizar":
          if (confirm("Finalizar esta ocorrencia?")) { Store.finalizar(id); renderBoard(); enviarEncerramento(Store.obter(id)); }
          break;
        case "sos":
          if (confirm("Finalizar o S.O.S. de passageiros? O tempo sera parado e o card vai para Aguardando.")) { Store.finalizarSOS(id); renderBoard(); }
          break;
        case "m-status": Store.mudarStatus(id, t.getAttribute("data-status")); abrirDetalhe(id); renderBoard(); break;
        case "m-add":
          var inp = $("#m-evento"); if (inp && inp.value.trim()) { Store.addEvento(id, inp.value.trim()); abrirDetalhe(id); renderBoard(); }
          break;
        case "m-finalizar":
          if (confirm("Finalizar esta ocorrencia?")) { Store.finalizar(id); fecharModal(); renderBoard(); renderHist(); enviarEncerramento(Store.obter(id)); }
          break;
        case "m-sos":
          if (confirm("Finalizar o S.O.S. de passageiros? O tempo sera parado e o card vai para Aguardando.")) { Store.finalizarSOS(id); abrirDetalhe(id); renderBoard(); }
          break;
        case "m-reabrir": Store.reabrir(id); abrirDetalhe(id); renderBoard(); break;
        case "m-copiar": copiar(whatsApp(Store.obter(id)), t); break;
        case "m-editar": fecharModal(); editar(Store.obter(id)); break;
        case "m-excluir":
          if (confirm("Excluir definitivamente?")) { Store.remover(id); fecharModal(); renderBoard(); renderHist(); }
          break;
        case "hist-del":
          if (confirm("Excluir do historico?")) { Store.remover(id); renderHist(); }
          break;
        case "loc-del": var L = Store.localidades(); L.splice(i, 1); Store.salvarLocalidades(L); renderLoc(); break;
        case "pa-del": var P = Store.pontosApoio(); P.splice(i, 1); Store.salvarPontosApoio(P); renderPa(); break;
        case "ger-del": Store.removerGerente(t.getAttribute("data-nome")); renderGer(); preencherDatalists(); break;
        case "ger-edit": var G = Store.gerentes()[i]; if (G) { $("#ger-nome").value = G.nome; $("#ger-tel").value = G.telefone || ""; } break;
        case "linha-del": var LN = Store.linhas(); LN.splice(i, 1); Store.salvarLinhas(LN); renderLinhas(); preencherDatalists(); break;
      }
    });
  }

  /* ---------------- Init ---------------- */
  function renderAtual() {
    if (currentView === "painel") renderBoard();
    else if (currentView === "historico") renderHist();
    else if (currentView === "cadastros") { renderFrota(); renderLoc(); renderPa(); renderGer(); }
    else if (currentView === "nova") preencherDatalists(); // cadastro mudou em outra maquina -> atualiza seletores (preserva selecao)
  }
  function aplicarModo() {
    var chip = $("#modoChip"), txt = $("#modoTexto"), remoto = (window.MODO === "remoto");
    if (chip) { chip.textContent = remoto ? "Tempo real" : "Modo local"; chip.classList.toggle("on", remoto); }
    if (txt) txt.textContent = remoto ? "conectado ao servidor compartilhado (Supabase)" : "dados locais neste navegador";
  }
  document.addEventListener("DOMContentLoaded", function () {
    preencherDatalists();
    wire();
    preencherDataHoje();
    aplicarModo();
    if (Store.onChange) Store.onChange(renderAtual);
    showView("painel");
    setInterval(tick, 1000);
    // Fila de envios: detecta se esta maquina tem a ponte e, se tiver, consome a fila.
    checarPonte(); setInterval(checarPonte, 20000);
    setInterval(drenarFila, 4000);
  });
})();
