<div align="center">

# 🐵 Amazon Tampermonkeys · FC GRU5

### Coleção de *userscripts* de automação e produtividade para o dia a dia do FC GRU5

Ferramentas para **Learning**, **Operations** e **WHS** — instaláveis com **1 clique** via [Tampermonkey](https://www.tampermonkey.net/).

<br/>

![Scripts](https://img.shields.io/badge/scripts-15-8A2BE2?style=for-the-badge&logo=tampermonkey&logoColor=white)
![Instalação](https://img.shields.io/badge/1--click_install-✔-00B894?style=for-the-badge)
![Userscript](https://img.shields.io/badge/Tampermonkey-required-FF9900?style=for-the-badge&logo=tampermonkey&logoColor=white)
![Made for](https://img.shields.io/badge/FC-GRU5-232F3E?style=for-the-badge)

</div>

---

## 🚀 TamperHub

O **TamperHub** é o catálogo visual (QuickSight QuickApp) para navegar, buscar e instalar todos os scripts deste repositório em 1 clique — com busca por nome, autor ou tag e filtros por time.

<!-- ┌──────────────────────────────────────────────────────────────────────┐
     │  IMAGEM DO TAMPERHUB                                                    │
     │  Coloque o print em  ./docs/tamperhub.png  (crie a pasta docs/)        │
     │  e ele aparece automaticamente abaixo.                                 │
     └──────────────────────────────────────────────────────────────────────┘ -->
<div align="center">

<img src="docs/tamperhub.png" alt="TamperHub — catálogo visual dos userscripts" width="880"/>

<br/>

**[🔗 Abrir o TamperHub →](https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/apps/012b9f90-24ac-49bc-a034-b4517cfa4085/view/TamperHub?sso_login=true)**

</div>

---

## 📦 Como instalar

1. Instale a extensão **[Tampermonkey](https://www.tampermonkey.net/)** no seu navegador (Chrome, Edge, Firefox, Opera ou Safari).
2. Clique no botão **⬇️ Instalar** do script desejado (na tabela abaixo ou no TamperHub).
3. O Tampermonkey intercepta o arquivo `.user.js` e abre a tela de instalação — confirme em **Instalar**.
4. Pronto! Abra a página do sistema alvo e o script já está ativo. Para **atualizar**, basta clicar de novo no mesmo link.

> 💡 Os scripts guardam configurações e estado localmente (armazenamento do Tampermonkey), por navegador/perfil.

---

## 🔧 Como extrair o link de instalação direta (para o TamperHub)

O **link de instalação direta** é simplesmente a URL **raw** do arquivo `.user.js` no GitHub. Quando o Tampermonkey está instalado, abrir essa URL dispara a tela de instalação automaticamente.

**Padrão do link:**

```
https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/<NOME-DO-ARQUIVO>.user.js
```

**Regras de codificação (URL-encoding)** — troque os caracteres especiais do nome do arquivo:

| Caractere | Vira | Exemplo |
|-----------|------|---------|
| espaço | `%20` | `Tot Batch` → `Tot%20Batch` |
| `+` | `%2B` | `Off-Task + Export` → `Off-Task%20%2B%20Export` |
| `→` (seta) | `%E2%86%92` | `GRU5 → Slack` → `GRU5%20%E2%86%92%20Slack` |
| `ô` (acento) | `%C3%B4` | `Cronômetro` → `Cron%C3%B4metro` |

**Como pegar rápido no próprio GitHub:** abra o arquivo `.user.js` no repositório → botão **Raw** → copie a URL da barra de endereços (já vem codificada). Cole essa URL no campo *Instalar / Atualizar* do card no TamperHub.

---

## 🗂️ Catálogo de scripts

> Clique em **⬇️ Instalar** para instalar/atualizar direto pelo Tampermonkey.

### 🎓 Learning

| Script | Ver. | O que faz | Instalar |
|--------|:----:|-----------|:--------:|
| **Minichecklist Learning** | `5.0` | Mini-checklist flutuante do turno (Onboarding D1/2/3, PA ou Support): detecta turno, dispara alertas por horário, aba **➕ Adicionar** para itens pessoais (com link e alerta) e painel de horas de Learning. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Minichecklist%20Learning-5.0.user.js) |
| **Apollo Audit - Cronômetro** | `1.7` | Cronômetro contra a expiração da sessão na auditoria do Apollo (alertas 7/9/10 min) e preenchimento automático do formulário com dados do Acompanhamento LC. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Apollo%20Audit%20-%20Cron%C3%B4metro-1.7.user.js) |
| **SIM - Tickets Learning GRU5 → Slack** | `4.1` | Conta tickets Pendentes/Em Progresso do grupo Learning GRU5 no SIM, agrupa por assignee e envia o resumo ao Slack (Block Kit), com painel flutuante. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/SIM%20-%20Tickets%20Learning%20GRU5%20%E2%86%92%20Slack%20(a%20cada%204h)-4.1.user.js) |

### ⚙️ Operations

| Script | Ver. | O que faz | Instalar |
|--------|:----:|-----------|:--------:|
| **Minichecklist Mecanismos** | `5.0` | Mini-checklist do turno (Mecanismos): pergunta gestor e cargo (PA/OPS/AM), lista por cargo, painel **Time On Task** (Inferred > 0.75 e Time Off Task) com alertas e Apollo pré-preenchido, e aba **➕ Adicionar** para itens pessoais. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Minichecklist%20Mecanismos-5.0.user.js) |
| **Tot Batch Submission Tool** | `8.2` | Ferramenta em Vue para codificar barras de Time on Task em lote no FCLM, com submissão paralela, seleção em massa e acompanhamento de progresso. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Tot%20Batch%20Submission%20Tool-8.2.user.js) |
| **FCLM Portal - Tempo Off-Task + Export CSV** | `4.8` | Overlay com o total de tempo off-task no ppaTimeOnTask, exporta CSV, aplica o visual Amazon à tabela e adiciona setas de ordenação. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20Portal%20-%20Tempo%20Off-Task%20%2B%20Export%20CSV-4.8.user.js) |
| **FCLM Intradays** | `3.7` | Botões de turno (All/Day/Night) e atalhos para Time On Task e Head Count no FCLM, além de um "SELECT ALL" no employeeRoster. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20Intradays-3.7.user.js) |
| **FCLM - TOT Dashboard Semanal** | `3.6` | Dashboard semanal de Time Off Task no FCLM com mapa Manager→Área e janelas 06:00→06:00, com integração ao Slack (cobrança por gestor). | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20TOT%20Dashboard%20Semanal-3.6.user.js) |
| **FCLM - PPA Attendance Export CSV** | `5.15` | Exporta o ppaAttendance em CSV/XLSX, detecta missed/duplicated punch, filtra por Manager/Shift e gera tickets de correção de ponto. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20PPA%20Attendance%20Export%20CSV-5.15.user.js) |
| **FCLM - Process Path Rollup (Leitor de Linhas)** | `2.9` | Lê linhas específicas (Line Items) do processPathRollup do FCLM e mostra a linha inteira de cada uma num painel flutuante. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20Process%20Path%20Rollup%20(Leitor%20de%20Linhas)-2.9.user.js) |
| **Who edited?** | `3.2` | No timeDetails do FCLM, mostra quem foi a última pessoa a codificar o tempo do associado, com histórico em dropdown e destaque OnClock/OffClock. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Who%20edited--3.2.user.js) |

### 🤝 Learning · Operations (uso compartilhado)

| Script | Ver. | O que faz | Instalar |
|--------|:----:|-----------|:--------:|
| **FCLM - Permissions Tags** | `5.33` | Transforma permissões e certificados do associado em tags coloridas no FCLM, verifica no Umbrella/LMS e automatiza em lote a remoção/revogação (re-onboarding). | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20Permissions%20Tags-5.33.user.js) |
| **Learning Hours - FCLM Overlay** | `4.0` | Versão só-visibilidade do overlay no functionRollup: horas de Learning/Onboarding por associado (acima do limite / precisa logar), com filtros, CSV e Slack. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Learning%20Hours%20-%20FCLM%20Overlay-4.0.user.js) |
| **Guided Coaching - Copiar Logins** | `2.11` | No Guided Coaching: copia o login (sem @), atalho ao Pick Console filtrado, filtro por Location, destaque do Current Location e gerador de nota de coaching. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Guided%20Coaching%20-%20Copiar%20Logins-2.11.user.js) |
| **Pick Console - Auto Refresh** | `1.1` | Recarrega o pick-workforce a cada 30s, com botão liga/desliga, contador regressivo e pausa automática quando a aba está em segundo plano. | [⬇️ Instalar](https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/Pick%20Console%20-%20Auto%20Refresh-1.1.user.js) |

---

## 🧭 Roadmap · em desenvolvimento

| Script | Ver. | O que faz | Tags |
|--------|:----:|-----------|------|
| **EHS Inspection - Download CSV** | `5.20` | Exporta inspeções do EHS em CSV/XLSX, dashboard com filtros, matriz Owner × dia, metas de FSI/Area Org, cobrança via Slack e email report em HTML. | WHS |
| **FCLM QPH por Process Path** | `4.2` | Painel que calcula o QPH médio por associado (Pick/Rebin/Pack) a partir do FCLM, com filtros, override via ObservedRate (SNS1) e export CSV. | FCLM · Produtividade |
| **Permissions Comparator** | `2.0` | Painel lateral que compara grupos/permissões de dois logins no Permissions Tool, mostrando comum × exclusivo, com filtros e busca. | Permissões · Segurança |

---

## 🛠️ Como contribuir

1. Faça o **fork** do repositório e crie uma branch (`git checkout -b meu-script`).
2. Adicione o seu `.user.js` na raiz do repositório, seguindo o padrão de nome `Nome do Script-<versão>.user.js`.
3. Preencha o cabeçalho `// ==UserScript==` com `@name`, `@version`, `@description`, `@match` e os `@grant` necessários.
4. Abra um **Pull Request** descrevendo o que o script faz e onde roda.

> Sempre que subir uma nova versão, **incremente o `@version`** e o número no nome do arquivo — assim o TamperHub e o Tampermonkey reconhecem a atualização.

---

<div align="center">

Feito com ☕ e 🍌 pelo time de **Mecanismos · FC GRU5**

</div>
