/* =========================================================================
   store.js  -  Camada de dados (repository) do Fluxo de Ocorrencias
   -------------------------------------------------------------------------
   Toda a aplicacao fala APENAS com window.Store. A persistencia atual e
   local (localStorage). Para a Fase 2 (sistema compartilhado em tempo real),
   basta criar outra implementacao com os MESMOS metodos (ex.: chamadas a uma
   API REST/WebSocket) e trocar a linha de inicializacao no fim do arquivo,
   sem mexer na interface.
   ========================================================================= */
(function () {
  "use strict";

  var KEY = "fluxoOcorrencias.v1";

  /* ---- Estados da ocorrencia (gamificacao = status visual) ------------- */
  var STATUS = {
    aberta:         { id: "aberta",         label: "Aberta",          cor: "#3a6ea5", icone: "!", ordem: 1, ativo: true },
    em_rota:        { id: "em_rota",        label: "Socorro em rota", cor: "#7b4fb0", icone: ">", ordem: 2, ativo: true },
    em_atendimento: { id: "em_atendimento", label: "Em atendimento",  cor: "#caa017", icone: "*", ordem: 3, ativo: true },
    aguardando:     { id: "aguardando",     label: "Aguardando",      cor: "#c75c1e", icone: "~", ordem: 4, ativo: true },
    finalizada:     { id: "finalizada",     label: "Finalizada",      cor: "#2e8b57", icone: "v", ordem: 5, ativo: false }
  };
  var STATUS_ATIVOS = ["aberta", "em_rota", "em_atendimento", "aguardando"];

  /* ---- Limiares de urgencia do cronometro (minutos) -------------------- */
  var URGENCIA = { ok: 30, atencao: 60, critico: 180 }; // <30 verde, 30-60 amarelo, 60-180 vermelho, >180 (3h) extremo

  /* ---- Utilidades ------------------------------------------------------ */
  function uid() { return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }
  function nowISO() { return new Date().toISOString(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function montarInicio(d, h) { if (!d || !h) return null; var ms = Date.parse(d + "T" + h + ":00"); return isNaN(ms) ? null : new Date(ms).toISOString(); }
  function horaHM(iso) { var d = new Date(iso), p = function (n) { return (n < 10 ? "0" : "") + n; }; return p(d.getHours()) + ":" + p(d.getMinutes()); }

  /* ---- Estado em memoria ----------------------------------------------- */
  var db = null;

  function seedCadastros() {
    var seed = window.SEED || {};
    return {
      frota:       (seed.frota || []).slice(),
      regionais:   (seed.regionais || []).slice(),
      gerentes:    (seed.gerentes || []).slice(),
      localidades: (seed.localidades || []).slice(),
      pontosApoio: (seed.pontosApoio || []).slice(),
      linhas:      (seed.linhas || []).slice()
    };
  }
  function seedVersao() { return (window.SEED && window.SEED.cadastrosVersao) || 1; }
  function defaults() {
    var seed = window.SEED || {};
    return {
      ocorrencias: [],
      cadastros: seedCadastros(),
      meta: { criadoEm: nowISO(), versao: 1, cadastrosVersao: seedVersao(), fonteFrota: seed.fonteFrota || "" }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { db = defaults(); save(); return; }
      var parsed = JSON.parse(raw);
      // Mescla cadastros novos do seed que ainda nao existem (ex.: frota atualizada)
      db = parsed && parsed.ocorrencias ? parsed : defaults();
      if (!db.cadastros) db.cadastros = defaults().cadastros;
      // Se a frota estiver vazia, recarrega do seed
      if (!db.cadastros.frota || !db.cadastros.frota.length) {
        db.cadastros.frota = (window.SEED && window.SEED.frota) || [];
      }
      // Atualiza cadastros quando a versao dos dados-semente muda (preserva ocorrencias)
      if (!db.meta) db.meta = {};
      if (db.meta.cadastrosVersao !== seedVersao()) {
        db.cadastros = seedCadastros();
        db.meta.cadastrosVersao = seedVersao();
        save();
      }
    } catch (e) {
      console.error("Falha ao carregar dados, iniciando vazio.", e);
      db = defaults();
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { console.error("Falha ao salvar (localStorage cheio?).", e); }
  }

  /* ---- Calculos de tempo ----------------------------------------------- */
  function duracaoMs(o, ate) {
    var base = o.inicioEm ? new Date(o.inicioEm).getTime() : new Date(o.abertaEm).getTime();
    var fim = o.socorroEm ? new Date(o.socorroEm).getTime() : (o.finalizadaEm ? new Date(o.finalizadaEm).getTime() : (ate || Date.now()));
    return Math.max(0, fim - base);
  }
  function nivelUrgencia(ms) {
    var min = ms / 60000;
    if (min < URGENCIA.ok) return "ok";
    if (min < URGENCIA.atencao) return "atencao";
    if (min < URGENCIA.critico) return "critico";
    return "extremo";
  }

  /* ---- Frota: busca e auto-preenchimento ------------------------------- */
  function buscarVeiculo(codigo) {
    if (!codigo) return null;
    var alvo = String(codigo).trim().toUpperCase();
    var lista = db.cadastros.frota || [];
    for (var i = 0; i < lista.length; i++) {
      if (String(lista[i].veiculo).toUpperCase() === alvo) return lista[i];
    }
    return null;
  }

  /* ---- API publica ----------------------------------------------------- */
  var Store = {
    STATUS: STATUS,
    STATUS_ATIVOS: STATUS_ATIVOS,
    URGENCIA: URGENCIA,

    /* ----- Ocorrencias ----- */
    listarAtivas: function () {
      return db.ocorrencias.filter(function (o) { return o.status !== "finalizada"; })
        .sort(function (a, b) { return new Date(a.abertaEm) - new Date(b.abertaEm); });
    },
    listarFinalizadas: function () {
      return db.ocorrencias.filter(function (o) { return o.status === "finalizada"; })
        .sort(function (a, b) { return new Date(b.finalizadaEm) - new Date(a.finalizadaEm); });
    },
    listarTodas: function () { return db.ocorrencias.slice(); },
    obter: function (id) { return db.ocorrencias.find(function (o) { return o.id === id; }) || null; },

    criar: function (dados) {
      var veic = buscarVeiculo(dados.carro);
      var o = Object.assign({
        carro: "", carroSegue: "", motorista: "", matricula: "",
        linha: "", localSocorro: "", dataViagem: "", horarioViagem: "",
        qtdClientes: "", encomendas: "Não", alimentacaoFornecida: "Não",
        defeitoMotorista: "", responsavelManutencao: "", saidaSocorro: "",
        gerenteRegional: "", coordenador: "", obs: "",
        servico: "", dataOcorrencia: "", horaQuebra: "", terminoSocorro: ""
      }, dados || {});
      o.id = uid();
      o.status = "aberta";
      o.abertaEm = nowISO();
      o.finalizadaEm = null;
      o.inicioEm = montarInicio(o.dataOcorrencia, o.horaQuebra) || o.abertaEm;
      // dados derivados da frota
      o.regional = veic ? veic.regional : (dados.regional || "");
      o.placa = veic ? veic.placa : "";
      o.capacidade = veic ? veic.capacidade : "";
      o.modelo = veic ? veic.modelo : "";
      o.eventos = [{ ts: o.abertaEm, tipo: "abertura", texto: "Ocorrencia aberta" }];
      db.ocorrencias.push(o);
      save();
      return o;
    },

    atualizar: function (id, patch) {
      var o = this.obter(id); if (!o) return null;
      Object.assign(o, patch);
      if (patch && patch.carro) {
        var v = buscarVeiculo(patch.carro);
        if (v) { o.regional = v.regional; o.placa = v.placa; o.capacidade = v.capacidade; o.modelo = v.modelo; }
      }
      var ini = montarInicio(o.dataOcorrencia, o.horaQuebra); if (ini) o.inicioEm = ini;
      if (o.finalizadaEm || o.socorroEm) o.duracaoMs = duracaoMs(o);
      o.eventos = o.eventos || [];
      o.eventos.push({ ts: nowISO(), tipo: "edicao", texto: "Ocorrencia editada" + (o.status === "finalizada" ? " (apos finalizacao)" : "") });
      save(); return o;
    },

    mudarStatus: function (id, status, texto) {
      var o = this.obter(id); if (!o || !STATUS[status]) return null;
      if (o.socorroEm && (status === "em_rota" || status === "em_atendimento" || status === "aberta")) {
        var pausa = Date.now() - new Date(o.socorroEm).getTime();
        o.inicioEm = new Date(new Date(o.inicioEm || o.abertaEm).getTime() + pausa).toISOString();
        o.socorroEm = null; o.terminoSocorro = ""; delete o.duracaoMs;
        o.eventos.push({ ts: nowISO(), tipo: "status", texto: "Tempo retomado (cronometro voltou a contar)" });
      }
      o.status = status;
      o.eventos.push({ ts: nowISO(), tipo: "status", texto: texto || ("Status: " + STATUS[status].label) });
      if (status === "finalizada" && !o.finalizadaEm) o.finalizadaEm = nowISO();
      if (status !== "finalizada") o.finalizadaEm = null;
      save(); return o;
    },

    addEvento: function (id, texto, tipo) {
      var o = this.obter(id); if (!o || !texto) return null;
      o.eventos.push({ ts: nowISO(), tipo: tipo || "medida", texto: texto });
      save(); return o;
    },
    marcarEscalado: function (id, nivel) {
      var o = this.obter(id); if (!o) return null;
      var mapa = { "90": ["escalado90", "Aviso de 1h30 enviado (responsavel e empresa)"],
                   "150": ["escalado150", "Aviso de 2h30 enviado (diretor)"],
                   "3h": ["escalado3h", "Alerta de 3h enviado (responsavel, empresa, grupo e diretor)"] };
      var m = mapa[nivel] || mapa["3h"];
      o.eventos.push({ ts: nowISO(), tipo: m[0], texto: m[1] });
      save(); return o;
    },

    finalizarSOS: function (id, texto) {
      var o = this.obter(id); if (!o) return null;
      if (!o.socorroEm) { o.socorroEm = nowISO(); o.terminoSocorro = horaHM(o.socorroEm); o.duracaoMs = duracaoMs(o); }
      o.status = "aguardando";
      o.eventos.push({ ts: nowISO(), tipo: "sos", texto: texto || ("S.O.S. passageiros concluido - tempo parado em " + o.terminoSocorro) });
      save(); return o;
    },
    finalizar: function (id, texto) {
      var o = this.obter(id); if (!o) return null;
      o.status = "finalizada";
      o.finalizadaEm = nowISO();
      if (!o.terminoSocorro) o.terminoSocorro = horaHM(o.finalizadaEm);
      o.duracaoMs = duracaoMs(o);
      o.eventos.push({ ts: o.finalizadaEm, tipo: "finalizacao", texto: texto || "Ocorrencia finalizada" });
      save(); return o;
    },

    reabrir: function (id) {
      var o = this.obter(id); if (!o) return null;
      o.status = "em_atendimento"; o.finalizadaEm = null; o.socorroEm = null; o.terminoSocorro = ""; delete o.duracaoMs;
      o.eventos.push({ ts: nowISO(), tipo: "status", texto: "Ocorrencia reaberta (tempo retomado)" });
      save(); return o;
    },

    remover: function (id) {
      db.ocorrencias = db.ocorrencias.filter(function (o) { return o.id !== id; });
      save();
    },

    /* ----- Tempo (helpers expostos para a UI) ----- */
    duracaoMs: duracaoMs,
    nivelUrgencia: nivelUrgencia,

    /* ----- Cadastros ----- */
    frota: function () { return db.cadastros.frota.slice(); },
    regionais: function () { return db.cadastros.regionais.slice(); },
    gerentes: function () { return db.cadastros.gerentes.slice(); },
    localidades: function () { return db.cadastros.localidades.slice(); },
    pontosApoio: function () { return db.cadastros.pontosApoio.slice(); },
    linhas: function () { return (db.cadastros.linhas || []).slice(); },
    buscarVeiculo: buscarVeiculo,

    salvarLocalidades: function (arr) { db.cadastros.localidades = arr || []; save(); },
    salvarLinhas: function (arr) { db.cadastros.linhas = arr || []; save(); },
    salvarPontosApoio: function (arr) { db.cadastros.pontosApoio = arr || []; save(); },
    salvarFrota: function (arr) { if (arr && arr.length) { db.cadastros.frota = arr; save(); } },
    salvarGerente: function (g) {
      if (!g || !g.nome) return;
      var L = db.cadastros.gerentes || [], i = -1;
      for (var k = 0; k < L.length; k++) { if (L[k] && L[k].nome === g.nome) { i = k; break; } }
      if (i >= 0) L[i] = { nome: g.nome }; else L.push({ nome: g.nome });   // LGPD: so nome
      db.cadastros.gerentes = L; save();
    },
    removerGerente: function (nome) { db.cadastros.gerentes = (db.cadastros.gerentes || []).filter(function (g) { return g.nome !== nome; }); save(); },

    /* ----- Export / Import ----- */
    exportarTudo: function () {
      return JSON.stringify({ exportadoEm: nowISO(), dados: db }, null, 2);
    },
    importarTudo: function (json) {
      var parsed = typeof json === "string" ? JSON.parse(json) : json;
      var novo = parsed && parsed.dados ? parsed.dados : parsed;
      if (!novo || !novo.ocorrencias) throw new Error("Arquivo invalido.");
      db = novo; save();
    },
    importarOcorrencias: function (lista, substituir) {
      if (substituir) db.ocorrencias = [];
      (lista || []).forEach(function (o) { if (!o.id) o.id = uid(); db.ocorrencias.push(o); });
      save();
    },

    /* ----- Manutencao ----- */
    onChange: function () {},
    resetTudo: function () { db = defaults(); save(); },
    _raw: function () { return clone(db); }
  };

  load();
  window.Store = Store;
  window.LocalStore = Store;
})();
