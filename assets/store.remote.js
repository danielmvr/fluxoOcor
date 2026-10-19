/* =====================================================================
   store.remote.js - RemoteStore (Supabase) com a MESMA interface do
   Store local. Mantem um cache em memoria sincronizado por Realtime,
   entao as leituras continuam sincronas (a interface nao muda) e as
   escritas sao otimistas (atualizam o cache na hora e enviam ao banco).
   Reaproveita STATUS/urgencia do Store local (window.LocalStore).
   ===================================================================== */
(function () {
  "use strict";
  function uid() { return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }
  function nowISO() { return new Date().toISOString(); }
  function montarInicio(d, h) { if (!d || !h) return null; var ms = Date.parse(d + "T" + h + ":00"); return isNaN(ms) ? null : new Date(ms).toISOString(); }
  function horaHM(iso) { var d = new Date(iso), p = function (n) { return (n < 10 ? "0" : "") + n; }; return p(d.getHours()) + ":" + p(d.getMinutes()); }
  function ymdLocal(iso) { var d = new Date(iso), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  // Monta o instante final (finalizacao/SOS) a partir da hora HH:MM editada.
  // Usa a data da ocorrencia (ou a data do fim atual); se a hora ficar antes do
  // inicio, assume o dia seguinte (socorro que passou da meia-noite).
  function montarFim(dataOcorr, horaFim, iniISO, fimAtualISO) {
    if (!horaFim) return null;
    var dia = dataOcorr || (fimAtualISO ? ymdLocal(fimAtualISO) : (iniISO ? ymdLocal(iniISO) : null));
    if (!dia) return null;
    var ms = Date.parse(dia + "T" + horaFim + ":00"); if (isNaN(ms)) return null;
    var ini = iniISO ? new Date(iniISO).getTime() : 0;
    if (ms < ini) ms += 86400000;
    return new Date(ms).toISOString();
  }

  var SIMPLES = ["carro","carroSegue","motorista","matricula","linha","localSocorro","dataViagem",
    "horarioViagem","qtdClientes","encomendas","alimentacaoFornecida","defeitoMotorista",
    "responsavelManutencao","saidaSocorro","gerenteRegional","coordenador","obs",
    "regional","placa","modelo","capacidade","servico","dataOcorrencia","horaQuebra","terminoSocorro","terminoData"];
  function toSnake(k) { return k.replace(/[A-Z]/g, function (c) { return "_" + c.toLowerCase(); }); }
  function objToRow(o) {
    var row = { id: o.id, status: o.status || "aberta", aberta_em: o.abertaEm || nowISO(),
      finalizada_em: o.finalizadaEm || null, inicio_em: o.inicioEm || null, socorro_em: o.socorroEm || null, duracao_ms: (o.duracaoMs == null ? null : o.duracaoMs),
      eventos: o.eventos || [] };
    SIMPLES.forEach(function (k) { row[toSnake(k)] = (o[k] == null ? null : o[k]); });
    return row;
  }
  function rowToObj(row) {
    var o = { id: row.id, status: row.status, abertaEm: row.aberta_em, finalizadaEm: row.finalizada_em,
      duracaoMs: row.duracao_ms, inicioEm: row.inicio_em, socorroEm: row.socorro_em, eventos: row.eventos || [],
      whatsAberturaEm: row.whats_abertura_em || null, whatsFimEm: row.whats_fim_em || null };
    SIMPLES.forEach(function (k) { o[k] = row[toSnake(k)]; });
    return o;
  }

  window.createRemoteStore = function (client, seed) {
    seed = seed || {};
    var L = window.LocalStore || {};
    var cad = {
      frota: (seed.frota || []).slice(), regionais: (seed.regionais || []).slice(),
      gerentes: (seed.gerentes || []).slice(), localidades: (seed.localidades || []).slice(),
      pontosApoio: (seed.pontosApoio || []).slice(), linhas: (seed.linhas || []).slice()
    };
    var cache = [], subs = [], ultimaEscrita = 0;
    function fire() { subs.forEach(function (f) { try { f(); } catch (e) {} }); }
    function findIdx(id) { for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return i; return -1; }
    function upsert(o) { var i = findIdx(o.id); if (i >= 0) cache[i] = o; else cache.push(o); }
    function buscarVeiculo(c) { if (!c) return null; var a = String(c).trim().toUpperCase();
      for (var i = 0; i < cad.frota.length; i++) if (String(cad.frota[i].veiculo).toUpperCase() === a) return cad.frota[i]; return null; }
    function dur(o, ate) { var base = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
      var fim = o.socorroEm ? new Date(o.socorroEm).getTime() : (o.finalizadaEm ? new Date(o.finalizadaEm).getTime() : (ate || Date.now())); return Math.max(0, fim - base); }
    // Duracao secundaria (SOS Mecanico): total da quebra ate a finalizacao completa.
    // Ignora a parada do S.O.S. passageiros; quando nao houve SOS, coincide com a principal.
    function durSec(o, ate) { var base = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
      var fim = o.finalizadaEm ? new Date(o.finalizadaEm).getTime() : (ate || Date.now()); return Math.max(0, fim - base); }
    function pushDB(o) {
      ultimaEscrita = Date.now();
      try { client.from("ocorrencias").upsert(objToRow(o)).then(function (r) { if (r && r.error) console.error("Supabase upsert:", r.error.message || r.error); }); }
      catch (e) { console.error("Supabase upsert falhou:", e); }
    }
    function carregar() {
      client.from("ocorrencias").select("*").then(function (res) {
        if (res && res.error) { console.error("Supabase select:", res.error.message || res.error); return; }
        cache = (res.data || []).map(rowToObj); fire();
      });
    }
    // Ressincronizacao LEVE (nao le o historico inteiro): busca so as ATIVAS (conjunto pequeno) e
    // confere as que sumiram do conjunto ativo (finalizadas/excluidas em outra estacao) uma a uma.
    function ressync() {
      client.from("ocorrencias").select("*").neq("status", "finalizada").then(function (res) {
        if (res && res.error) { console.error("Supabase ressync:", res.error.message || res.error); return; }
        var idsDB = {};
        (res.data || []).forEach(function (row) { var o = rowToObj(row); idsDB[o.id] = 1; upsert(o); });
        // cards ativos no cache que nao vieram como ativos do banco -> buscar estado atual (curam telas com dado velho)
        cache.filter(function (o) { return o.status !== "finalizada" && !idsDB[o.id]; }).forEach(function (o) {
          client.from("ocorrencias").select("*").eq("id", o.id).limit(1).then(function (r2) {
            if (r2 && r2.error) return;
            var row = r2.data && r2.data[0];
            if (row) { upsert(rowToObj(row)); }                                   // finalizada em outra estacao
            else { var i = findIdx(o.id); if (i >= 0) cache.splice(i, 1); }        // excluida em outra estacao
            fire();
          }, function () {});
        });
        fire();
      }, function () {});
    }
    function assinarRealtime() {
      try {
        client.channel("ocorrencias-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "ocorrencias" }, function (payload) {
            if (payload.eventType === "DELETE") { var i = findIdx(payload.old.id); if (i >= 0) cache.splice(i, 1); }
            else { upsert(rowToObj(payload.new)); }
            fire();
          }).subscribe();
      } catch (e) { console.error("Realtime indisponivel:", e); }
    }

    // ---- Cadastros compartilhados (tabela "cadastros": uma linha por tipo) ----
    var TIPOS = ["gerentes", "linhas", "localidades", "pontosApoio", "frota"];
    function seedVer() { return (window.SEED && window.SEED.cadastrosVersao) || 1; }
    function pushCad(tipo) {
      try { client.from("cadastros").upsert({ tipo: tipo, itens: cad[tipo] || [] }).then(function (r) { if (r && r.error) console.error("Supabase cadastros upsert (" + tipo + "):", r.error.message || r.error); }); }
      catch (e) { console.error("Supabase cadastros upsert falhou:", e); }
    }
    function pushVersao(v) {
      try { client.from("cadastros").upsert({ tipo: "_versao", itens: v }).then(function () {}); } catch (e) {}
    }
    function mergeStrings(dst, seedArr) { var out = (dst || []).slice(); (seedArr || []).forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); }); return out; }
    function mergeFrota(dst, seedArr) { var out = (dst || []).slice(), have = {}; out.forEach(function (x) { have[String(x.veiculo).toUpperCase()] = 1; }); (seedArr || []).forEach(function (s) { var k = String(s.veiculo).toUpperCase(); if (!have[k]) { out.push(s); have[k] = 1; } }); return out; }
    function mergeGerentes(dst, seedArr) { var out = (dst || []).slice(), have = {}; out.forEach(function (x) { have[x.nome] = 1; }); (seedArr || []).forEach(function (s) { if (!have[s.nome]) { out.push({ nome: s.nome }); have[s.nome] = 1; } }); return out; } // LGPD: so nome no cadastro publico
    function mergeTipo(tipo, seedArr) {
      if (tipo === "gerentes") return mergeGerentes(cad[tipo], seedArr);
      if (tipo === "frota") return mergeFrota(cad[tipo], seedArr);
      return mergeStrings(cad[tipo], seedArr);
    }
    function carregarCadastros() {
      client.from("cadastros").select("*").then(function (res) {
        if (res && res.error) { console.error("Supabase cadastros select:", res.error.message || res.error); return; }
        var map = {}; (res.data || []).forEach(function (r) { map[r.tipo] = r.itens; });
        var storedVer = (typeof map._versao === "number") ? map._versao : 0;
        var sv = seedVer(), mudou = [];
        TIPOS.forEach(function (tipo) {
          var seedArr = (seed[tipo] || []);
          if (map[tipo] == null) { cad[tipo] = seedArr.slice(); mudou.push(tipo); }           // banco vazio: carga inicial do seed
          else { cad[tipo] = map[tipo]; if (sv > storedVer) { var m = mergeTipo(tipo, seedArr); if (m.length !== cad[tipo].length) { cad[tipo] = m; mudou.push(tipo); } } }
        });
        mudou.forEach(pushCad);
        if (sv > storedVer) pushVersao(sv);
        fire();
      });
    }
    function assinarCadastros() {
      try {
        client.channel("cadastros-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "cadastros" }, function (payload) {
            var row = payload.new; if (!row || !row.tipo || row.tipo === "_versao") return;
            if (TIPOS.indexOf(row.tipo) >= 0) { cad[row.tipo] = row.itens || []; fire(); }
          }).subscribe();
      } catch (e) { console.error("Realtime cadastros indisponivel:", e); }
    }

    var Store = {
      MODO: "remoto",
      STATUS: L.STATUS, STATUS_ATIVOS: L.STATUS_ATIVOS, URGENCIA: L.URGENCIA,
      onChange: function (cb) { if (typeof cb === "function") subs.push(cb); },

      listarAtivas: function () { return cache.filter(function (o) { return o.status !== "finalizada"; })
        .sort(function (a, b) { return new Date(a.abertaEm) - new Date(b.abertaEm); }); },
      listarFinalizadas: function () { return cache.filter(function (o) { return o.status === "finalizada"; })
        .sort(function (a, b) { return new Date(b.finalizadaEm) - new Date(a.finalizadaEm); }); },
      listarTodas: function () { return cache.slice(); },
      obter: function (id) { var i = findIdx(id); return i >= 0 ? cache[i] : null; },

      criar: function (dados) {
        var v = buscarVeiculo(dados.carro);
        var o = Object.assign({ carro:"",carroSegue:"",motorista:"",matricula:"",linha:"",localSocorro:"",
          dataViagem:"",horarioViagem:"",qtdClientes:"",encomendas:"Não",alimentacaoFornecida:"Não",
          defeitoMotorista:"",responsavelManutencao:"",saidaSocorro:"",gerenteRegional:"",coordenador:"",obs:"",
          servico:"",dataOcorrencia:"",horaQuebra:"",terminoSocorro:"",terminoData:"" }, dados || {});
        o.id = uid(); o.status = "aberta"; o.abertaEm = nowISO(); o.finalizadaEm = null;
        o.inicioEm = montarInicio(o.dataOcorrencia, o.horaQuebra) || o.abertaEm;
        o.regional = v ? v.regional : (dados.regional || ""); o.placa = v ? v.placa : "";
        o.capacidade = v ? v.capacidade : ""; o.modelo = v ? v.modelo : "";
        o.eventos = [{ ts: o.abertaEm, tipo: "abertura", texto: "Ocorrencia aberta" }];
        upsert(o); fire(); pushDB(o); return o;
      },
      atualizar: function (id, patch) { var o = this.obter(id); if (!o) return null; Object.assign(o, patch);
        if (patch && patch.carro) { var v = buscarVeiculo(patch.carro); if (v) { o.regional=v.regional; o.placa=v.placa; o.capacidade=v.capacidade; o.modelo=v.modelo; } }
        var ini = montarInicio(o.dataOcorrencia, o.horaQuebra); if (ini) o.inicioEm = ini;
        // registro ja parado (finalizado/SOS): recalcula o instante final pela hora de termino editada
        if (o.terminoSocorro && (o.finalizadaEm || o.socorroEm)) {
          var fim = montarFim(o.terminoData || o.dataOcorrencia, o.terminoSocorro, o.inicioEm || o.abertaEm, o.socorroEm || o.finalizadaEm);
          if (fim) { if (o.socorroEm) o.socorroEm = fim; else o.finalizadaEm = fim; }
        }
        if (o.finalizadaEm || o.socorroEm) o.duracaoMs = dur(o);
        o.eventos = o.eventos || []; o.eventos.push({ ts: nowISO(), tipo: "edicao", texto: "Ocorrencia editada" + (o.status === "finalizada" ? " (apos finalizacao)" : "") });
        fire(); pushDB(o); return o; },
      mudarStatus: function (id, status, texto) { var o = this.obter(id); if (!o || !L.STATUS[status]) return null;
        if (o.socorroEm && (status === "em_rota" || status === "em_atendimento" || status === "aberta")) {
          var pausa = Date.now() - new Date(o.socorroEm).getTime();
          o.inicioEm = new Date(new Date(o.inicioEm || o.abertaEm).getTime() + pausa).toISOString();
          o.socorroEm = null; o.terminoSocorro = ""; o.terminoData = ""; delete o.duracaoMs;
          o.eventos.push({ ts: nowISO(), tipo: "status", texto: "Tempo retomado (cronometro voltou a contar)" });
        }
        o.status = status; o.eventos.push({ ts: nowISO(), tipo: "status", texto: texto || ("Status: " + L.STATUS[status].label) });
        if (status === "finalizada" && !o.finalizadaEm) o.finalizadaEm = nowISO();
        if (status !== "finalizada") o.finalizadaEm = null; fire(); pushDB(o); return o; },
      addEvento: function (id, texto, tipo) { var o = this.obter(id); if (!o || !texto) return null;
        o.eventos.push({ ts: nowISO(), tipo: tipo || "medida", texto: texto }); fire(); pushDB(o); return o; },
      marcarEscalado: function (id, nivel) { var o = this.obter(id); if (!o) return null;
        var mapa = { "90": ["escalado90", "Aviso de 1h30 enviado (responsavel e empresa)"],
                     "150": ["escalado150", "Aviso de 2h30 enviado (diretor)"],
                     "3h": ["escalado3h", "Alerta de 3h enviado (responsavel, empresa, grupo e diretor)"] };
        var m = mapa[nivel] || mapa["3h"];
        o.eventos.push({ ts: nowISO(), tipo: m[0], texto: m[1] }); fire(); pushDB(o); return o; },
      finalizarSOS: function (id, texto) { var o = this.obter(id); if (!o) return null;
        if (!o.socorroEm) { o.socorroEm = nowISO(); o.terminoSocorro = horaHM(o.socorroEm); o.terminoData = ymdLocal(o.socorroEm); o.duracaoMs = dur(o); }
        o.status = "aguardando";
        o.eventos.push({ ts: nowISO(), tipo: "sos", texto: texto || ("S.O.S. passageiros concluido - tempo parado em " + o.terminoSocorro) }); fire(); pushDB(o); return o; },
      finalizar: function (id, texto) { var o = this.obter(id); if (!o) return null; o.status = "finalizada";
        o.finalizadaEm = nowISO(); if (!o.terminoSocorro) { o.terminoSocorro = horaHM(o.finalizadaEm); o.terminoData = ymdLocal(o.finalizadaEm); } o.duracaoMs = dur(o);
        o.eventos.push({ ts: o.finalizadaEm, tipo: "finalizacao", texto: texto || "Ocorrencia finalizada" }); fire(); pushDB(o); return o; },
      reabrir: function (id) { var o = this.obter(id); if (!o) return null; o.status = "em_atendimento";
        o.finalizadaEm = null; o.socorroEm = null; o.terminoSocorro = ""; o.terminoData = ""; delete o.duracaoMs; o.eventos.push({ ts: nowISO(), tipo: "status", texto: "Ocorrencia reaberta (tempo retomado)" }); fire(); pushDB(o); return o; },
      remover: function (id) { var i = findIdx(id); if (i >= 0) cache.splice(i, 1); fire();
        try { client.from("ocorrencias").delete().eq("id", id).then(function (r) { if (r && r.error) console.error("Supabase delete:", r.error.message || r.error); }); }
        catch (e) { console.error("Supabase delete falhou:", e); } },

      // ---- Fila de envios: qualquer maquina enfileira; SO a maquina da ponte consome/envia ----
      enviarFila: function (chave, mensagem, destinos) {
        if (!destinos || !destinos.length) return Promise.resolve(null);
        var row = { id: uid(), chave: chave || uid(), mensagem: mensagem || "", destinos: destinos, criado_em: nowISO() };
        return client.from("envios").upsert(row, { onConflict: "chave", ignoreDuplicates: true }); // dedup por chave
      },
      filaPendentes: function () { return client.from("envios").select("*").is("enviado_em", null).order("criado_em", { ascending: true }); },
      claimEnvio: function (id) { return client.from("envios").update({ enviado_em: nowISO() }).eq("id", id).is("enviado_em", null).select(); },
      liberarEnvio: function (id) { return client.from("envios").update({ enviado_em: null }).eq("id", id); },
      consumirBacklog: function () { return client.from("envios").update({ enviado_em: nowISO() }).is("enviado_em", null); },

      // Confirma (marca a ocorrencia) que o WhatsApp realmente saiu. Chamado pela maquina da ponte
      // quando a ponte respondeu ok. Update direcionado numa coluna (nao sobrescreve o resto) e
      // idempotente (so marca se ainda estava vazio). tipo: abertura/90/150/3h -> abertura; fim -> fim.
      confirmarWhats: function (id, tipo) {
        if (!id) return;
        if (tipo === "fim") {
          client.from("ocorrencias").update({ whats_fim_em: nowISO() }).eq("id", id).is("whats_fim_em", null).then(function () {}, function () {});
        } else if (tipo === "abertura" || tipo === "90" || tipo === "150" || tipo === "3h") {
          client.from("ocorrencias").update({ whats_abertura_em: nowISO() }).eq("id", id).is("whats_abertura_em", null).then(function () {}, function () {});
        }
      },

      // Le a ocorrencia direto do banco (fonte da verdade) e atualiza o cache local.
      // Usado como "checagem dupla" antes de disparar alerta: evita alertar card ja finalizado em outra estacao.
      lerOcorrenciaDB: function (id) {
        return client.from("ocorrencias").select("*").eq("id", id).limit(1).then(function (res) {
          if (res && res.error) return null;
          var row = res.data && res.data[0]; if (!row) return null;
          var o = rowToObj(row); upsert(o); return o; // atualiza o cache (cura estacao com dado velho)
        }, function () { return null; });
      },

      duracaoMs: dur,
      duracaoSecundariaMs: durSec,
      nivelUrgencia: L.nivelUrgencia,

      frota: function () { return cad.frota.slice(); },
      regionais: function () { return cad.regionais.slice(); },
      gerentes: function () { return cad.gerentes.slice(); },
      linhas: function () { return (cad.linhas || []).slice(); },
      localidades: function () { return cad.localidades.slice(); },
      pontosApoio: function () { return cad.pontosApoio.slice(); },
      buscarVeiculo: buscarVeiculo,
      salvarLocalidades: function (arr) { cad.localidades = arr || []; pushCad("localidades"); fire(); },
      salvarPontosApoio: function (arr) { cad.pontosApoio = arr || []; pushCad("pontosApoio"); fire(); },
      salvarFrota: function (arr) { if (arr && arr.length) { cad.frota = arr; pushCad("frota"); fire(); } },
      salvarGerente: function (g) {
        if (!g || !g.nome) return;
        var i = -1; for (var k = 0; k < cad.gerentes.length; k++) { if (cad.gerentes[k].nome === g.nome) { i = k; break; } }
        var item = { nome: g.nome };   // LGPD: telefone nao vai para o cadastro publico
        if (i >= 0) cad.gerentes[i] = item; else cad.gerentes.push(item);
        pushCad("gerentes"); fire();
      },
      removerGerente: function (nome) { cad.gerentes = cad.gerentes.filter(function (g) { return g.nome !== nome; }); pushCad("gerentes"); fire(); },
      salvarLinhas: function (arr) { cad.linhas = arr || []; pushCad("linhas"); fire(); },

      exportarTudo: function () { return JSON.stringify({ exportadoEm: nowISO(), dados: { ocorrencias: cache.slice(), cadastros: cad } }, null, 2); },
      importarTudo: function (json) { var p = typeof json === "string" ? JSON.parse(json) : json; var novo = p && p.dados ? p.dados : p;
        if (!novo || !novo.ocorrencias) throw new Error("Arquivo invalido.");
        (novo.ocorrencias || []).forEach(function (o) { if (!o.id) o.id = uid(); upsert(o); pushDB(o); }); fire(); },

      _carregar: carregar, _assinar: assinarRealtime, _cache: function () { return cache; }
    };
    carregar(); assinarRealtime();
    carregarCadastros(); assinarCadastros();
    // Ressincroniza com o banco a cada 30s (cura estacoes cuja conexao em tempo real caiu,
    // ex.: TV aberta por horas). Leve: so as ativas. Nao roda logo apos escrita local (evita reverter otimista).
    setInterval(function () { if (Date.now() - ultimaEscrita > 4000) ressync(); }, 30000);
    return Store;
  };
})();
