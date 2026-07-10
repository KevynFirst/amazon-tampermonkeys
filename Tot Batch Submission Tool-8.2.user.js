// ==UserScript==
// @name         Tot Batch Submission Tool
// @namespace    http://tampermonkey.net/
// @version      8.2
// @description  Batch ToT coding tool with parallel submission and progress tracking
// @author       @ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        fclm-portal.integ.amazon.com/employee/timeDetails*
// @match        fclm-portal.integ.amazon.com/employee/ppaTimeDetails*
// @match        fclm-portal.amazon.com/employee/timeDetails*
// @match        fclm-portal.amazon.com/employee/ppaTimeDetails*
// @require      https://v2.vuejs.org/js/vue.js
// @grant        none
// @run-at       document-end
// ==/UserScript==
// v8.1 — Botão fixo flutuante (canto inferior direito) que rola suavemente até o painel
//        da ferramenta (#tot-batch-tool). Some sozinho quando o painel já está visível.
// v8.2 — Botão vira alternável: quando o painel está visível (você está na aplicação),
//        muda para "↑ TOPO" e sobe ao topo; fora dele, "↓ TOT TOOL" desce até o painel.


window.globalThat = {};




function sublist(code, cb) {
    var warehouseId = document.getElementById("warehouseId").value;
    if (typeof jediClient === 'undefined') {
        console.error('jediClient is not defined');
        cb({laborFunctions: []});
        return;
    }
    jediClient.getAllNonDirectLaborFunctionsForLaborProcessId({
        ServiceName: 'FCLMJobEntryDomainInformationService',
        data: { warehouseId: warehouseId, processId: code },
        Method: 'GetAllNonDirectLaborFunctionsForLaborProcessId',
        success: cb,
        error: function(err) {
            console.error('Error getting labor functions:', err);
            cb({laborFunctions: []});
        }
    });
}


function submitTot(tots){
    var newProcess = window.vueInstance.selectedLaborProcess;
    var newFunction= window.vueInstance.selectedLaborFunction;
    var empId = document.getElementById("employeeId").value;
    var whId  = document.getElementById("warehouseId").value;
    var startDate   = document.getElementById("startDate").value;
    var startHour   = document.getElementById("startHour").value;
    var startMinute = document.getElementById("startMinute").value;
    var endDate   = document.getElementById("endDate").value;
    var endHour   = document.getElementById("endHour").value;
    var endMinute = document.getElementById("endMinute").value;
    var totForm = document.getElementById("tot");
    var urlVal = totForm ? totForm.action : "/fragments/timeManagement";
    var totalTots = tots.length;
    var completedTots = 0;
    var successfulTots = 0;
    var failedTots = [];


    var updateProgress = function() {
        completedTots++;
        var progress = Math.round((completedTots / totalTots) * 100);
        window.vueInstance.message = "Submitting: " + completedTots + " of " + totalTots + " (" + progress + "%)";
        if (completedTots === totalTots) {
            if (failedTots.length === 0) {
                window.vueInstance.message = "✓ Successfully submitted all " + successfulTots + " ToT bar(s)! Reloading...";
                setTimeout(function() { location.reload(); }, 2000);
            } else {
                window.vueInstance.message = "⚠ Completed: " + successfulTots + " successful, " + failedTots.length + " failed";
                window.vueInstance.message2 = "Failed bars: " + failedTots.join(", ");
            }
        }
    };


    tots.forEach(function(tot){
        var enc = encodeURIComponent;
        var line = "startDate=" + enc(startDate) + "&startHour=" + enc(startHour) + "&startMinute=" + enc(startMinute) +
                   "&endDate=" + enc(endDate) + "&endHour=" + enc(endHour) + "&endMinute=" + enc(endMinute) +
                   "&employeeId=" + enc(empId) + "&warehouseId=" + enc(whId) +
                   "&laborFuncStartTime=" + enc(tot[1]) + "&laborFuncEndTime=" + enc(tot[3]) +
                   "&newLaborProcessId=" + enc(newProcess) + "&newLaborFunctionId=" + enc(newFunction);
        var currentUrl = urlVal;
        if(window.location.pathname.includes("ppa")){
            currentUrl = "/ajax/employee/updatePPATimeSegment";
            line = line.replace("warehouseId","oldWarehouseId");
            var loc = line.search("&newLaborProcessId");
            line = line.slice(0,loc)+"&warehouseId="+enc(whId)+line.slice(loc);
            loc = line.search("&newLaborFunctionId");
            line = line.slice(0,loc) + "&newJobRole=" + newFunction.replaceAll(" ", "+");
            line += "&previousLaborProcess=" + enc(tot[4]) + "&previousJobRole=" + enc(tot[5]);
        }
        $.ajax({
            url: currentUrl, type: 'POST', data: line,
            success: function(response){
                successfulTots++;
                window.vueInstance.processResponse(response, tot[tot.length-1], newProcess, newFunction);
                updateProgress();
            },
            error: function(xhr, status, error) {
                console.error('Submission error for ToT bar ' + tot[tot.length-1] + ':', error);
                failedTots.push(tot[tot.length-1] + 1);
                updateProgress();
            }
        });
    });
}


function withinTimeSpan(query, spanStart, spanEnd){
    var q = query.split(":");
    var qHour = Number(q[0]);
    var qMin  = Number(q[1]);
    for(var i = spanStart.getHours(); i <= spanEnd.getHours();){
        if(i == qHour){
            if(i == spanStart.getHours() && qMin < spanStart.getMinutes()) return false;
            if(i == spanEnd.getHours()   && qMin > spanEnd.getMinutes())   return false;
            return true;
        }
        if(i < 23) i++; else i = 0;
    }
    return false;
}


window.globalThat.sublist    = sublist;
window.globalThat.submitTot  = submitTot;


(function() {
    'use strict';


    if (!document.getElementById('content-panel'))    return;
    if (!document.getElementById('newLaborProcessId')) return;


    // ── Injeta estilos Amazon ──────────────────────────────────────────────
    var styleTag = document.createElement('style');
    styleTag.innerHTML = `
        /* ── Container principal ── */
        #tot-batch-tool {
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 13px;
            color: #111111;
        }
        /* ── Título ── */
        #tot-batch-tool h3 {
            color: #232F3E;
            border-bottom: 2px solid #FF9900;
            padding-bottom: 6px;
            margin-bottom: 12px;
            font-size: 15px;
            text-align: center;
        }
        /* ── Tabela ── */
        #tot-batch-tool table {
            border-collapse: collapse;
            width: 100%;
            border-radius: 6px;
            overflow: hidden;
            box-shadow: 0 1px 4px rgba(0,0,0,0.1);
        }
        #tot-batch-tool thead tr {
            background: #232F3E;
            color: #FFFFFF;
        }
        #tot-batch-tool thead th {
            padding: 9px 12px;
            font-size: 12px;
            letter-spacing: 0.03em;
            text-align: center;
        }
        #tot-batch-tool tbody tr {
            border-bottom: 1px solid #E8E8E8;
            transition: background 0.1s ease;
        }
        #tot-batch-tool tbody tr:nth-child(even) {
            background-color: #F7F7F7;
        }
        #tot-batch-tool tbody tr:hover {
            background-color: #FFF3CD;
        }
        #tot-batch-tool td {
            padding: 7px 12px;
        }
        /* ── Selects ── */
        #tot-batch-tool select {
            border: 1px solid #A9A9A9;
            border-radius: 4px;
            padding: 6px 10px;
            font-family: Arial, sans-serif;
            font-size: 12px;
            background: #FFFFFF;
            cursor: pointer;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
            min-width: 200px;
            margin-right: 10px;
        }
        #tot-batch-tool select:focus {
            outline: none;
            border-color: #FF9900;
            box-shadow: 0 0 0 2px rgba(255,153,0,0.25);
        }
        /* ── Botões ── */
        #tot-batch-tool button {
            transition: all 0.15s ease;
            border-radius: 5px;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-weight: bold;
            font-size: 12px;
            cursor: pointer;
            border: none;
            padding: 7px 16px;
            margin-right: 6px;
        }
        /* Select All — teal Amazon */
        #tot-batch-tool .btn-select-all {
            background-color: #007185;
            color: #FFFFFF;
            border: 1px solid #005F73;
            padding: 5px 12px;
            font-size: 11px;
        }
        #tot-batch-tool .btn-select-all:hover {
            background-color: #005F73;
            box-shadow: 0 3px 8px rgba(0,0,0,0.2);
            transform: translateY(-1px);
            outline: 2px solid #007185;
            outline-offset: 2px;
        }
        /* Deselect All — cinza neutro */
        #tot-batch-tool .btn-deselect-all {
            background-color: #8C8C8C;
            color: #FFFFFF;
            border: 1px solid #6B6B6B;
            padding: 5px 12px;
            font-size: 11px;
        }
        #tot-batch-tool .btn-deselect-all:hover {
            background-color: #6B6B6B;
            box-shadow: 0 3px 8px rgba(0,0,0,0.2);
            transform: translateY(-1px);
            outline: 2px solid #8C8C8C;
            outline-offset: 2px;
        }
        /* Select Uncoded — preto com letra branca */
        #tot-batch-tool .btn-select-uncoded {
            background-color: #111111;
            color: #FFFFFF;
            border: 1px solid #000000;
            padding: 5px 12px;
            font-size: 11px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        }
        #tot-batch-tool .btn-select-uncoded:hover {
            background-color: #333333;
            box-shadow: 0 4px 14px rgba(0,0,0,0.5);
            transform: translateY(-1px);
            outline: 2px solid #111111;
            outline-offset: 2px;
        }
        /* Prev Task — azul escuro Amazon */
        #tot-batch-tool .btn-prev-task {
            background-color: #37475A;
            color: #FFFFFF;
            border: 1px solid #232F3E;
        }
        #tot-batch-tool .btn-prev-task:hover {
            background-color: #232F3E;
            box-shadow: 0 3px 8px rgba(0,0,0,0.25);
            transform: translateY(-1px);
            outline: 2px solid #131921;
            outline-offset: 2px;
        }
        /* Submit — outline laranja, letra laranja; hover fundo laranja + letra branca */
        #tot-batch-tool .btn-submit {
            background-color: #FFFFFF;
            color: #FF9900;
            border: 2px solid #FF9900;
            padding: 10px 32px;
            font-size: 14px;
            box-shadow: 0 2px 6px rgba(255,153,0,0.25);
            letter-spacing: 0.03em;
            transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
        }
        #tot-batch-tool .btn-submit:hover {
            background-color: #FF9900;
            color: #FFFFFF;
            box-shadow: 0 5px 16px rgba(255,153,0,0.55);
            transform: translateY(-2px);
            outline: 2px solid #FF9900;
            outline-offset: 2px;
        }
        /* ── Mensagens ── */
        #tot-batch-tool .msg-success { color: #067D62; font-weight: bold; }
        #tot-batch-tool .msg-error   { color: #B12704; font-weight: bold; }
        #tot-batch-tool .msg-info    { color: #007185; font-weight: bold; }
        #tot-batch-tool .msg-default { color: #111111; font-weight: bold; }
        #tot-batch-tool .msg-sub     { color: #565959; font-style: italic; font-size: 12px; }
    `;
    document.head.appendChild(styleTag);
    // ──────────────────────────────────────────────────────────────────────


    var editables = document.getElementsByClassName('editable');
    var i;
    var editablesArray = [];
    for(i = 0; i < editables.length; i++){
        if(!editables[i].className.includes("example") &&
            editables[i].parentNode.hasAttribute("onclick") &&
            editables[i].parentNode.attributes.onclick.nodeValue.startsWith("firePopup")) {
            editablesArray.push(editables[i]);
        }
    }


    var parseFire = function(args) {
        return eval(args.replace('firePopup(','[').replace(');',']').replace('\t','').replace('\n',''));
    };


    var totParams = editablesArray.map(ed => parseFire(ed.parentNode.attributes.onclick.nodeValue));
    window.globalThat.totParams = totParams;


    var contentPanel = document.getElementById('content-panel');
    var root = document.createElement('div');
    root.id = 'root';
    root.style.marginTop      = '20px';
    root.style.padding        = '16px';
    root.style.border         = '2px solid #232F3E';
    root.style.borderRadius   = '8px';
    root.style.backgroundColor = '#FFFFFF';
    root.style.boxShadow      = '0 3px 10px rgba(0,0,0,0.12)';
    contentPanel.append(root);


    window.vueInstance = new Vue({
        data: {
            totParams: totParams.map(params => params.concat(false)),
            processOptions: [...document.getElementById('newLaborProcessId')].map(option => ({ value: option.value, label: option.text })),
            sublist: sublist,
            submitTot: submitTot,
            selectedLaborProcess: -1,
            functionOptions: [{laborFunctionId: -1, laborFunctionName: 'Choose Function'}],
            selectedLaborFunction: -1,
            message: "",
            message2: "",
            progressPercent: 0,
            submittedlist: [],
            now: Date.now(),
            lastCodedProcess: "",
            lastCodedFunction: "",
            loadLastCoded: false,
        },
        watch: {
            selectedLaborProcess: function() { this.newSubList; },
            totParams:            function() { this.updateTotalDuration; }
        },
        created: function(){
            var savedProcess = window.localStorage.getItem("totProcess");
            if(savedProcess != null) this.selectedLaborProcess = savedProcess;
        },
        computed: {
            newSubList(){
                if(window.location.pathname.includes("ppaTimeDetails")){
                    if(typeof processes === 'undefined'){
                        this.functionOptions = [{laborFunctionId: -1, laborFunctionName: 'Error: processes not found'}];
                        return 0;
                    }
                    var selectedLabel = this.processOptions.filter(x => x.value == this.selectedLaborProcess)[0].label;
                    var funclist = processes[selectedLabel].attributes.job_role.sort();
                    this.functionOptions = [{laborFunctionId: -1, laborFunctionName: 'Choose Function'}];
                    funclist.forEach(x => this.functionOptions.push({laborFunctionId: x, laborFunctionName: x}));
                    if(this.loadLastCoded){
                        var lastFunc = this.functionOptions.find(obj => obj.laborFunctionName === this.lastCodedFunction);
                        if(lastFunc) this.selectedLaborFunction = lastFunc.laborFunctionId.toString();
                        this.loadLastCoded = false;
                    }
                    var savedFunction = window.localStorage.getItem("totFunction");
                    if(savedFunction != null) this.selectedLaborFunction = savedFunction;
                } else {
                    this.seekFunctions(false);
                    return sublist(this.selectedLaborProcess, (result) => {
                        if(result && result.laborFunctions){
                            this.functionOptions = result.laborFunctions.sort((a,b) => a.laborFunctionName > b.laborFunctionName ? 1 : -1);
                            this.functionOptions.unshift({laborFunctionId: -1, laborFunctionName: 'Choose Function'});
                        } else {
                            this.functionOptions = [{laborFunctionId: -1, laborFunctionName: 'No functions available'}];
                        }
                        this.seekFunctions(true);
                    });
                }
                return 0;
            },
            updateTotalDuration(){
                var total = 0;
                this.totParams.filter(p => p[p.length-1] == true).forEach(bar => (total += this.getDuration(bar[1], bar[3])));
                this.message2 = total > 0 ? (Math.round(total*10)/10).toString() + " minutes selected" : "";
            },
        },
        methods: {
            fireTots() {
                window.localStorage.setItem("totProcess",  this.selectedLaborProcess);
                window.localStorage.setItem("totFunction", this.selectedLaborFunction);
                var selectedIndices = [];
                for(var i = 0; i < this.totParams.length; i++){
                    var ci = this.totParams[i].length - 1;
                    if(this.totParams[i][ci] === true) selectedIndices.push(i);
                }
                if(selectedIndices.length === 0){ this.message = "Please select at least one ToT bar!"; return; }
                if(this.selectedLaborProcess <= 0 || this.selectedLaborProcess == -1){ this.message = "Please select a labor process!"; return; }
                if((this.selectedLaborFunction <= 0 || this.selectedLaborFunction == -1) && !window.location.pathname.includes("ppa")){ this.message = "Please select a labor function!"; return; }
                var totSend = [];
                selectedIndices.forEach(function(idx){
                    var tot = this.totParams[idx].slice(0, -1);
                    tot.push(idx);
                    totSend.push(tot);
                }.bind(this));
                this.submitTot(totSend);
                this.message = "Submitting " + totSend.length + " ToT bar(s)...";
            },
            loadLastCodedBar() {
                var lcp = "", lcf = "", foundEdited = false;
                for(var i = editablesArray.length-1; i >= 0; i--){
                    if(editablesArray[i].parentElement.parentElement.className == "function-seg edited"){
                        lcp = totParams[i][4]; lcf = totParams[i][5]; foundEdited = true; break;
                    }
                }
                if(foundEdited){
                    this.lastCodedProcess = lcp; this.lastCodedFunction = lcf;
                    var lastProcessOption = this.processOptions.find(obj => obj.label === lcp);
                    if(!lastProcessOption){ this.message2 = "Previous process not found in dropdown."; return; }
                    var lastProcessCode = lastProcessOption.value;
                    if(lastProcessCode == this.selectedLaborProcess && this.functionOptions.some(f => f.laborFunctionName === lcf)){
                        var lastFuncOption = this.functionOptions.find(obj => obj.laborFunctionName === lcf);
                        if(lastFuncOption) this.selectedLaborFunction = lastFuncOption.laborFunctionId.toString();
                    } else {
                        this.loadLastCoded = true;
                        this.selectedLaborProcess = lastProcessCode;
                    }
                } else {
                    this.message2 = "No previously edited bar found to copy.";
                }
            },
            processResponse(response, totIndex, procId, funcId){
                this.message = "";
                if(window.location.pathname.includes("ppa")){
                    var toLocalTime = function(timestamp) {
                        const date = new Date(timestamp);
                        const offset = date.getTimezoneOffset();
                        const localDate = new Date(date.getTime() - (offset * 60000));
                        const hours   = Math.abs(Math.floor(offset / 60)).toString().padStart(2,'0');
                        const minutes = Math.abs(offset % 60).toString().padStart(2,'0');
                        const ms = localDate.getMilliseconds().toString().padStart(3,'0');
                        const offsetString = (offset < 0 ? '+' : '-') + hours + minutes;
                        return localDate.toISOString().slice(0,-5) + '.' + ms + offsetString;
                    };
                    if(toLocalTime(response.laborFuncStartTime) == totParams[totIndex][1] &&
                       toLocalTime(response.laborFuncEndTime)   == totParams[totIndex][3] &&
                       response.errors == null){
                        var proc = this.processOptions.filter(x => x.value == procId)[0].label;
                        this.totParams[totIndex][4] = proc;
                        this.totParams[totIndex][5] = funcId;
                        this.submittedlist.push(totIndex);
                        this.$forceUpdate();
                        this.message = "Submission Successful!"; this.message2 = "";
                    } else {
                        let errorString = "Unknown error";
                        if(response.errors != null){
                            errorString = response.errors.toString();
                            if(errorString.startsWith("Function is for a direct or exempt job")) errorString = "Function is for a direct or exempt job";
                        }
                        this.message = "Response error. Element: " + totIndex + ": " + errorString;
                    }
                } else {
                    var doc = (new DOMParser()).parseFromString(response, 'text/html');
                    var editables = doc.getElementsByClassName('editable');
                    var editablesArray = [];
                    for(var i = 0; i < editables.length; i++){
                        if(!editables[i].className.includes("example") &&
                            editables[i].parentNode.hasAttribute("onclick") &&
                            editables[i].parentNode.attributes.onclick.nodeValue.startsWith("firePopup"))
                            editablesArray.push(editables[i]);
                    }
                    var parseFire = function(args){ return eval(args.replace('firePopup(','[').replace(');',']').replace('\t','').replace('\n','')); };
                    var respParams = editablesArray.map(ed => parseFire(ed.parentNode.attributes.onclick.nodeValue));
                    if(respParams.some(resp => resp.length === totParams[totIndex].length && resp.every((element,i) => element === totParams[totIndex][i]))){
                        var procOption = this.processOptions.filter(x => x.value == procId)[0];
                        var funcOption = this.functionOptions.filter(x => x.laborFunctionId == Number(funcId))[0];
                        if(procOption && funcOption){
                            this.totParams[totIndex][4] = procOption.label;
                            this.totParams[totIndex][5] = funcOption.laborFunctionName;
                            this.submittedlist.push(totIndex);
                            this.$forceUpdate();
                            this.message = "Submission Successful!"; this.message2 = "";
                        } else {
                            this.message = "Error: Could not find process or function in options";
                        }
                    } else {
                        let errorString = "Unknown error";
                        if(response.indexOf("<div className=\" error-message message\">") >= 0){
                            try {
                                errorString = response.split("<div className=\" error-message message\">")[1].split("</div>")[0].trim().split(" ").slice(1).join(" ");
                                if(errorString.startsWith("Function is for a direct or exempt job")) errorString = "Function is for a direct or exempt job";
                            } catch(e) { errorString = "Error parsing response"; }
                        }
                        this.message = "Response error. Element: " + totIndex + ": " + errorString;
                    }
                }
            },
            seekFunctions(isDone){
                if(!isDone){
                    this.functionOptions = [{laborFunctionId: -1, laborFunctionName: '-= Getting New Functions =-'}];
                    this.message = "Getting Functions...";
                } else {
                    this.message = ""; this.message2 = "";
                    var savedFunction = null;
                    if(!this.loadLastCoded){
                        if(this.selectedLaborProcess == window.localStorage.getItem("totProcess"))
                            savedFunction = window.localStorage.getItem("totFunction");
                    } else {
                        var lastFuncOption = this.functionOptions.find(obj => obj.laborFunctionName === this.lastCodedFunction);
                        if(lastFuncOption) savedFunction = lastFuncOption.laborFunctionId.toString();
                    }
                    if(savedFunction != null) this.selectedLaborFunction = savedFunction;
                    this.loadLastCoded = false;
                }
            },
            getDuration(date1, date2){
                date1 = new Date(date1);
                date2 = date2.length > 0 ? new Date(date2) : this.now;
                return Math.abs((date2 - date1) / 60000);
            },
            checkPunch(totStart, totEnd) {
                // Verifica se start/end estão dentro das janelas válidas de ponto
                var inWindow = function(h, m, wsh, wsm, weh, wem) {
                    var t = h * 60 + m;
                    var s = wsh * 60 + wsm;
                    var e = weh * 60 + wem;
                    return t >= s && t <= e;
                };
                // Valida START: 05:55-06:05 ou 17:55-18:05
                var s   = new Date(totStart);
                var sh  = s.getHours(), sm = s.getMinutes();
                var validStart = inWindow(sh, sm, 5, 55, 6, 5) || inWindow(sh, sm, 17, 55, 18, 5);
                // Valida END: 17:55-18:05 ou 04:55-05:05 (ignora se "(current)")
                var validEnd = true;
                if (totEnd && totEnd.length > 0) {
                    var e   = new Date(totEnd);
                    var eh  = e.getHours(), em = e.getMinutes();
                    validEnd = inWindow(eh, em, 17, 55, 18, 5) || inWindow(eh, em, 4, 55, 5, 5);
                }
                if (!validStart && !validEnd) return "⚠ In/Out";
                if (!validStart) return "⚠ In";
                if (!validEnd)   return "⚠ Out";
                return "";
            },
            allTotDuration(){
                var total = 0;
                this.totParams.forEach(bar => (total += this.getDuration(bar[1], bar[3])));
                return total > 0 ? " — " + (Math.round(total*10)/10).toString() + "m in " + this.totParams.length + " bars" : " — No editable time.";
            },
            selectAllBars(){
                for(var i = 0; i < this.totParams.length; i++){
                    this.$set(this.totParams[i], this.totParams[i].length-1, true);
                }
                this.message2 = "Selected " + this.totParams.length + " ToT bar(s)";
            },
            deselectAllBars(){
                for(var i = 0; i < this.totParams.length; i++){
                    this.$set(this.totParams[i], this.totParams[i].length-1, false);
                }
                this.message2 = "Deselected all ToT bars";
            },
            selectUncodedBars(){
                var count = 0;
                for(var i = 0; i < this.totParams.length; i++){
                    // Uncoded = sem processo (tot[4]) e sem função (tot[5])
                    var isUncoded = !this.totParams[i][4] || this.totParams[i][4] === '';
                    this.$set(this.totParams[i], this.totParams[i].length-1, isUncoded);
                    if(isUncoded) count++;
                }
                this.message2 = count > 0
                    ? "Selected " + count + " uncoded bar(s)"
                    : "No uncoded bars found — all bars already have a process";
            },
            getMsgClass(msg){
                if(msg.includes('✓') || msg.includes('Successful')) return 'msg-success';
                if(msg.includes('error') || msg.includes('Error') || msg.includes('⚠')) return 'msg-error';
                if(msg.includes('Submitting')) return 'msg-info';
                return 'msg-default';
            }
        },


        // ── Template com design Amazon ────────────────────────────────────
        template: `
        <div id="tot-batch-tool">


            <h3>ToT Batch Submission Tool<span style="font-size:12px; font-weight:normal; color:#565959;">{{allTotDuration()}}</span></h3>


            <table>
                <thead>
                    <tr>
                        <th>Select</th>
                        <th>Start</th>
                        <th>Punch</th>
                        <th>End</th>
                        <th>Duration</th>
                        <th>Process</th>
                        <th>Function</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(tot, totRow) in totParams">
                        <td style="text-align:center;">
                            <input type="checkbox" v-model="totParams[totRow][totParams[totRow].length - 1]" />
                        </td>
                        <td>{{tot[0].length > 0 ? tot[0].substring(0,5) + tot[0].substring(10,16) : "(current)"}}</td>
                        <td><span style="color:#B12704; font-weight:bold;">{{checkPunch(tot[1],tot[3])}}</span></td>
                        <td>
                            <span v-if="tot[2].length> 0">{{tot[2].substring(0,5) + tot[2].substring(10,16)}}</span>
                            <span v-else style="color:#FF9900; font-weight:bold;">(current)</span>
                        </td>
                        <td>{{Math.round(getDuration(tot[1],tot[3])).toString()+"m"}}</td>
                        <td v-bind:style="{ color: submittedlist.includes(totRow) ? '#067D62' : '#111', fontWeight: submittedlist.includes(totRow) ? 'bold' : 'normal' }">
                            {{tot[4] || '—'}}
                        </td>
                        <td v-bind:style="{ color: submittedlist.includes(totRow) ? '#067D62' : '#111', fontWeight: submittedlist.includes(totRow) ? 'bold' : 'normal' }">
                            {{tot[5] || '—'}}
                        </td>
                    </tr>
                </tbody>
            </table>


            <div style="margin: 14px 0 10px 0;">
                <select v-model="selectedLaborProcess">
                    <option v-for="process in processOptions" v-bind:value="process.value">{{process.label}}</option>
                </select>
                <select v-model="selectedLaborFunction">
                    <option v-for="func in functionOptions" v-bind:value="func.laborFunctionId">{{func.laborFunctionName}}</option>
                </select>
            </div>


            <div style="margin: 10px 0 6px 0;">
                <button className="btn-select-all"     @click="selectAllBars()">☑ Select All</button>
                <button className="btn-deselect-all"   @click="deselectAllBars()">☐ Deselect All</button>
                <button className="btn-select-uncoded" @click="selectUncodedBars()">⚑ Select Uncoded</button>
            </div>
            <div style="margin: 6px 0 12px 0;">
                <button className="btn-prev-task" @click="loadLastCodedBar()">Prev. Task</button>
                <button className="btn-submit"    @click="fireTots()">▶ Submit</button>
            </div>


            <div v-if="message" :class="getMsgClass(message)" style="margin: 8px 0;">{{message}}</div>
            <div v-if="message2" className="msg-sub" style="margin: 4px 0;">{{message2}}</div>


        </div>
        `,
    }).$mount(root);


    // ── Botão fixo: rola até o painel da ferramenta (v8.1) ─────────────────
    (function injectJumpButton() {
        if (document.getElementById('tot-jump-btn')) return;


        var btn = document.createElement('button');
        btn.id = 'tot-jump-btn';
        btn.type = 'button';
        btn.title = 'Ir para o TOT Batch Tool';
        btn.innerHTML = '<span class="tot-jump-icon">\u2193</span><span class="tot-jump-label">TOT TOOL</span>';
        Object.assign(btn.style, {
            position:      'fixed',
            bottom:        '20px',
            right:         '20px',
            zIndex:        '2147483000',
            display:       'flex',
            flexDirection: 'column',
            alignItems:    'center',
            justifyContent:'center',
            gap:           '2px',
            width:         '64px',
            height:        '64px',
            padding:       '0',
            lineHeight:    '1',
            color:         '#FF9900',
            background:    'linear-gradient(145deg,#232F3E 0%,#131921 100%)',
            border:        '2px solid #FF9900',
            borderRadius:  '14px',
            cursor:        'pointer',
            boxShadow:     '0 4px 16px rgba(0,0,0,0.6)',
            fontFamily:    "'Amazon Ember',Arial,sans-serif",
            transition:    'transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease',
            userSelect:    'none',
        });


        var iconEl  = btn.querySelector('.tot-jump-icon');
        iconEl.style.cssText  = 'font-size:24px;font-weight:bold;line-height:1;transition:transform 0.25s ease;';
        var labelEl = btn.querySelector('.tot-jump-label');
        labelEl.style.cssText = 'font-size:8px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;';


        btn.addEventListener('mouseenter', function() {
            btn.style.transform  = 'translateY(-3px) scale(1.06)';
            btn.style.boxShadow  = '0 8px 24px rgba(0,0,0,0.7)';
            btn.style.background = 'linear-gradient(145deg,#37475A 0%,#232F3E 100%)';
        });
        btn.addEventListener('mouseleave', function() {
            btn.style.transform  = 'none';
            btn.style.boxShadow  = '0 4px 16px rgba(0,0,0,0.6)';
            btn.style.background = 'linear-gradient(145deg,#232F3E 0%,#131921 100%)';
        });
        // mode: 'tool' → desce até o painel · 'top' → sobe ao topo (quando já está na aplicação)
        var mode = 'tool';
        function setMode(m) {
            mode = m;
            if (m === 'top') {
                iconEl.textContent  = '\u2191';         // seta para cima
                labelEl.textContent = 'TOPO';
                btn.title = 'Voltar ao topo';
            } else {
                iconEl.textContent  = '\u2193';         // seta para baixo
                labelEl.textContent = 'TOT TOOL';
                btn.title = 'Ir para o TOT Batch Tool';
            }
        }


        btn.addEventListener('click', function() {
            if (mode === 'top') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                var target = document.getElementById('tot-batch-tool') || document.getElementById('root');
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });


        // Quando o painel já está visível (você está na aplicação) → botão vira "ir ao topo"
        var toolEl = document.getElementById('tot-batch-tool') || root;
        if ('IntersectionObserver' in window && toolEl) {
            var io = new IntersectionObserver(function(entries) {
                var vis = entries[0] && entries[0].isIntersecting;
                setMode(vis ? 'top' : 'tool');
            }, { threshold: 0.15 });
            io.observe(toolEl);
        }


        // hover: ajusta o "pulo" da seta conforme o modo
        btn.addEventListener('mouseenter', function() { iconEl.style.transform = mode === 'top' ? 'translateY(-3px)' : 'translateY(3px)'; });
        btn.addEventListener('mouseleave', function() { iconEl.style.transform = 'none'; });


        document.body.appendChild(btn);
    })();
})();
