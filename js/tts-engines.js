
var browserTtsEngine = brapi.tts ? new BrowserTtsEngine() : (typeof speechSynthesis != 'undefined' ? new WebSpeechEngine() : new DummyTtsEngine());
var remoteTtsEngine = new RemoteTtsEngine(config.serviceUrl);
var googleTranslateTtsEngine = new GoogleTranslateTtsEngine();
var amazonPollyTtsEngine = new AmazonPollyTtsEngine();
var googleWavenetTtsEngine = new GoogleWavenetTtsEngine();
var ibmWatsonTtsEngine = new IbmWatsonTtsEngine();
var nvidiaRivaTtsEngine = new NvidiaRivaTtsEngine();
var phoneTtsEngine = new PhoneTtsEngine();
var openaiTtsEngine = new OpenaiTtsEngine();
var azureTtsEngine = new AzureTtsEngine();


/*
interface Options {
  voice: {
    voiceName: string
    autoSelect?: boolean
  }
  lang: string
  rate?: number
  pitch?: number
  volume?: number
}

interface Event {
  type: string
}

interface Voice {
  voiceName: string
  lang: string
}

interface TtsEngine {
  speak: function(text: string, opts: Options, onEvent: (e:Event) => void): void
  stop: function(): void
  pause: function(): void
  resume: function(): void|Promise<void>
  isSpeaking: function(callback): void
  getVoices: function(): Voice[]
}
*/

function BrowserTtsEngine() {
  brapi.tts.stop()    //workaround: chrome.tts.speak doesn't work first time on cold start for some reason
  this.speak = function(text, options, onEvent) {
    brapi.tts.speak(text, {
      voiceName: options.voice.voiceId || options.voice.voiceName,
      lang: options.lang,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      requiredEventTypes: ["start", "end"],
      desiredEventTypes: ["start", "end", "error"],
      onEvent: onEvent
    })
  }
  this.stop = brapi.tts.stop;
  this.pause = brapi.tts.pause;
  this.resume = brapi.tts.resume;
  this.isSpeaking = brapi.tts.isSpeaking;
  this.getVoices = async function() {
    const voices = await new Promise(f => brapi.tts.getVoices(f)) || []
    const platform = await brapi.runtime.getPlatformInfo()
    if (platform.os == "mac") {
      for (const voice of voices) {
          if (voice.remote == false && !voice.voiceName.includes(" ")) {
            voice.voiceId = voice.voiceName
            voice.voiceName = "MacOS " + (languageTable.getNameFromCode(voice.lang) || voice.lang) + " [" + voice.voiceId + "]"
          }
      }
    }
    return voices
  }
}


function WebSpeechEngine() {
  var utter;
  this.speak = function(text, options, onEvent) {
    utter = new SpeechSynthesisUtterance();
    utter.text = text;
    utter.voice = options.voice;
    if (options.lang) utter.lang = options.lang;
    if (options.pitch) utter.pitch = options.pitch;
    if (options.rate) utter.rate = options.rate;
    if (options.volume) utter.volume = options.volume;
    utter.onstart = onEvent.bind(null, {type: 'start', charIndex: 0});
    utter.onend = onEvent.bind(null, {type: 'end', charIndex: text.length});
    utter.onerror = function(event) {
      if (event.error == "canceled" || event.error == "interrupted") return;
      onEvent({type: 'error', error: new Error(event.error)});
    };
    speechSynthesis.cancel()
    speechSynthesis.speak(utter);
  }
  this.stop = function() {
    if (utter) utter.onend = null;
    speechSynthesis.cancel();
  }
  this.pause = function() {
    speechSynthesis.pause();
  }
  this.resume = function() {
    speechSynthesis.resume();
  }
  this.isSpeaking = function(callback) {
    callback(speechSynthesis.speaking);
  }
  this.getVoices = function() {
    return promiseTimeout(20000, "Timeout WebSpeech getVoices", new Promise(function(fulfill) {
      var voices = speechSynthesis.getVoices() || [];
      if (voices.length) fulfill(voices);
      else speechSynthesis.onvoiceschanged = function() {
        fulfill(speechSynthesis.getVoices() || []);
      }
    }))
    .then(function(voices) {
      for (var i=0; i<voices.length; i++) voices[i].voiceName = voices[i].name;
      return voices;
    })
    .catch(function(err) {
      console.error(err);
      return [];
    })
  }
}


function DummyTtsEngine() {
  this.getVoices = function() {
    return Promise.resolve([]);
  }
}


function TimeoutTtsEngine(baseEngine, timeoutMillis) {
  var timer;
  this.speak = function(text, options, onEvent) {
    var started = false;
    clearTimeout(timer);
    timer = setTimeout(function() {
      baseEngine.stop();
      if (started) onEvent({type: "end", charIndex: text.length});
      else onEvent({type: "error", error: new Error("Timeout, TTS never started, try picking another voice?")});
    },
    timeoutMillis);
    baseEngine.speak(text, options, function(event) {
        if (event.type == "start") started = true;
        if (event.type == "end" || event.type == "error") clearTimeout(timer);
        onEvent(event);
    })
  }
  this.stop = function() {
    clearTimeout(timer);
    baseEngine.stop();
  }
  this.isSpeaking = baseEngine.isSpeaking;
}


function RemoteTtsEngine(serviceUrl) {
  var prefetchAudio;
  var isSpeaking = false;
  var nextStartTime = 0;

  var audio;
  var apiurl;


  function ready(options) {
    return getSettings(["openaiCreds"])
    .then(function(items) {
     
      if (items.openaiCreds) {
        apiurl = items.openaiCreds.apiKey;
      }

    })
  }
  this.speak = async function(utterance, options, onEvent) {
    const urlPromise = ready(options)
      .then(function() {
        
        //return getAudioUrl(utterance, options.lang, options.voice)

        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options){
          return prefetchAudio[2];
        }
        else {
          
          return getAudioUrl(utterance);

        }

      })
    audio = playAudio(urlPromise, options, nextStartTime)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  }
  this.pause =
  this.stop = function() {
    audio.pause()
  }
  this.resume = function() {
    return audio.resume()
  }


  // this.prefetch = function(utterance, options) {
  //   if (!isIOS()) {
  //     ajaxGet(getAudioUrl(utterance));
  //   }
  // }


  this.prefetch = async function(utterance, options) {
    ajaxGet(getAudioUrl(utterance))
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };


  this.setNextStartTime = function(time, options) {
    // if (!isIOS())
    //   nextStartTime = time || 0;
  }
  this.getVoices = function() {
    return voices;
  }
  async function getAudioUrl(utterance) {
    assert(utterance);

    return encodeURI(apiurl+"&text="+utterance);

    // return serviceUrl + "/read-aloud/speak/" + lang + "/" + encodeURIComponent(voice.voiceName) + "?c=" + encodeURIComponent(clientId) + "&t=" + encodeURIComponent(authToken) + (voice.autoSelect ? '&a=1' : '') + "&v=" + manifest.version + "&pf=" + (prefetch ? 1 : 0) + "&q=" + encodeURIComponent(utterance);
  }
  var voices = [
      {"voice_name": "Amazon GPT-Sovits", "lang": "en-AU", "gender": "female", "event_types": ["start", "end", "error"]},
      {"voice_name": "Amazon Australian English (Russell)", "lang": "en-AU", "gender": "male", "event_types": ["start", "end", "error"]},
      
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
    .concat(
      {voiceName: "ReadAloud Generic Voice", autoSelect: true},
    )
}


function GoogleTranslateTtsEngine() {
  var prefetchAudio;
  var isSpeaking = false;
  var audio;
  this.ready = function() {
    return googleTranslateReady();
  };
  this.speak = function(utterance, options, onEvent) {
    options.rateAdjust = 1.1
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice.lang);
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice.lang)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return voices;
  }
  function getAudioUrl(text, lang) {
    assert(text && lang);
    return googleTranslateSynthesizeSpeech(text, lang);
  }
  var voices = [
      {"voice_name": "GoogleTranslate Afrikaans", "lang": "af", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Albanian", "lang": "sq", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Arabic", "lang": "ar", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Armenian", "lang": "hy", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bengali", "lang": "bn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bosnian", "lang": "bs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bulgarian", "lang": "bg", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Catalan", "lang": "ca", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Chinese", "lang": "zh-CN", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Croatian", "lang": "hr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Czech", "lang": "cs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Danish", "lang": "da", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Dutch", "lang": "nl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate English", "lang": "en", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Esperanto", "lang": "eo", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Estonian", "lang": "et", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Filipino", "lang": "fil", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Finnish", "lang": "fi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate French", "lang": "fr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate German", "lang": "de", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Greek", "lang": "el", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Gujarati", "lang": "gu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hebrew", "lang": "he", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hindi", "lang": "hi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hungarian", "lang": "hu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Icelandic", "lang": "is", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Indonesian", "lang": "id", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Italian", "lang": "it", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Japanese", "lang": "ja", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Javanese", "lang": "jw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Kannada", "lang": "kn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Khmer", "lang": "km", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Korean", "lang": "ko", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latin", "lang": "la", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latvian", "lang": "lv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Macedonian", "lang": "mk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malay", "lang": "ms", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malayalam", "lang": "ml", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Marathi", "lang": "mr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Myanmar (Burmese)", "lang": "my", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Nepali", "lang": "ne", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Norwegian", "lang": "no", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Polish", "lang": "pl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Portuguese", "lang": "pt", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Romanian", "lang": "ro", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Russian", "lang": "ru", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Serbian", "lang": "sr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sinhala", "lang": "si", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Slovak", "lang": "sk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Spanish", "lang": "es", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sundanese", "lang": "su", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swahili", "lang": "sw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swedish", "lang": "sv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tagalog", "lang": "tl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tamil", "lang": "ta", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Telugu", "lang": "te", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Thai", "lang": "th", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Turkish", "lang": "tr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Ukrainian", "lang": "uk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Urdu", "lang": "ur", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Vietnamese", "lang": "vi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Welsh", "lang": "cy", "event_types": ["start", "end", "error"]}
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
}


function AmazonPollyTtsEngine() {
  var getPolly = lazy(createPolly)
  var prefetchAudio;
  var isSpeaking = false;
  var audio;
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.lang, options.voice, options.pitch);
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.lang, options.voice, options.pitch)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = async function() {
    try {
      const {awsCreds, pollyVoices} = await getSettings(["awsCreds", "pollyVoices"])
      if (!awsCreds) return []
      if (pollyVoices && pollyVoices.expire > Date.now()) return pollyVoices.list
      const list = await fetchVoices()
      await updateSettings({pollyVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  async function fetchVoices() {
    const polly = await getPolly()
    const data = await polly.describeVoices().promise()
    const voices = []
    for (const voice of data.Voices) {
      assert(voice.SupportedEngines && voice.Id)
      if (voice.SupportedEngines.includes("standard")) voices.push(voice);
      if (voice.SupportedEngines.includes("neural")) voices.push({...voice, Style: "neural"})
      if (polly.newscasterVoices.includes(voice.Id)) voices.push({...voice, Style: "newscaster"})
      if (polly.conversationalVoices.includes(voice.Id)) voices.push({...voice, Style: "conversational"})
    }
    return voices.map(voice => {
      assert(voice.Gender)
      let voiceName = `AmazonPolly ${voice.LanguageName} (${voice.Id})`;
      if (voice.Style) voiceName += ` +${voice.Style}`;
      return {
        voiceName,
        lang: voice.LanguageCode,
        gender: voice.Gender.toLowerCase(),
      }
    })
  }
  async function getAudioUrl(text, lang, voice, pitch) {
    assert(text && lang && voice);
    var matches = voice.voiceName.match(/^AmazonPolly .* \((\w+)\)( \+\w+)?$/);
    var voiceId = matches[1];
    var style = matches[2] && matches[2].substr(2);
    const polly = await getPolly()
    const blob = await polly.synthesizeSpeech(getOpts(text, voiceId, style)).promise()
    return URL.createObjectURL(blob);
  }
  function createPolly() {
    return getSettings(["awsCreds"])
      .then(function(items) {
        if (!items.awsCreds) throw new Error("Missing AWS credentials");
        return new AWS.Polly({
          region: "us-east-1",
          accessKeyId: items.awsCreds.accessKeyId,
          secretAccessKey: items.awsCreds.secretAccessKey
        })
      })
  }
  function getOpts(text, voiceId, style) {
    switch (style) {
      case "newscaster":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="news">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "conversational":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="conversational">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "neural":
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId,
          Engine: "neural"
        }
      default:
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId
        }
    }
  }
}


function GoogleWavenetTtsEngine() {
  var prefetchAudio;
  var isSpeaking = false;
  var audio;
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice, options.pitch);
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice, options.pitch)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return getSettings(["wavenetVoices", "gcpCreds"])
      .then(function(items) {
        if (!items.wavenetVoices || Date.now()-items.wavenetVoices[0].ts > 24*3600*1000) updateVoices();
        var listvoices = items.wavenetVoices || voices;
        var creds = items.gcpCreds;
        return listvoices.filter(
          function(voice) {
            // include all voices or exclude only studio voices.
            return ((creds && creds.enableStudio) || !isGoogleStudio(voice));
          });
      })
  }
  this.getFreeVoices = function() {
    return this.getVoices()
      .then(function(items) {
        return items.filter(function(item) {
          return item.voiceName.match(/^GoogleStandard /);
        })
      })
  }
  function updateVoices() {
    ajaxGet(config.serviceUrl + "/read-aloud/list-voices/google")
      .then(JSON.parse)
      .then(function(list) {
        list[0].ts = Date.now();
        updateSettings({wavenetVoices: list});
      })
  }
  function getAudioUrl(text, voice, pitch) {
    assert(text && voice);
    var matches = voice.voiceName.match(/^Google(\w+) .* \((\w+)\)$/);
    var voiceName = voice.lang + "-" + matches[1] + "-" + matches[2][0];
    var endpoint = matches[1] == "Neural2" ? "us-central1-texttospeech.googleapis.com" : "texttospeech.googleapis.com";
    return getSettings(["gcpCreds", "gcpToken"])
      .then(function(settings) {
        var postData = {
          input: {
            text: text
          },
          voice: {
            languageCode: voice.lang,
            name: voiceName
          },
          audioConfig: {
            audioEncoding: "OGG_OPUS",
            pitch: ((pitch || 1) -1) *20
          }
        }
        if (settings.gcpCreds) return ajaxPost("https://" + endpoint + "/v1/text:synthesize?key=" + settings.gcpCreds.apiKey, postData, "json");
        if (!settings.gcpToken) throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
        return ajaxPost("https://cxl-services.appspot.com/proxy?url=https://texttospeech.googleapis.com/v1beta1/text:synthesize&token=" + settings.gcpToken, postData, "json")
          .catch(function(err) {
            console.error(err);
            throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
          })
      })
      .then(function(responseText) {
        var data = JSON.parse(responseText);
        return "data:audio/ogg;codecs=opus;base64," + data.audioContent;
      })
  }
  var voices = [
    {"voiceName":"GoogleStandard Spanish; Castilian (Anna)","lang":"es-ES","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Anna)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Benjamin)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Christopher)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Diane)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard French (Elizabeth)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Anna)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Elizabeth)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Anna)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Benjamin)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Russian (Caroline)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Daniel)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Diane)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Anna)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Benjamin)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Christopher)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Anna)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Bianca)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Christopher)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Daniel)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Anna)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Bianca)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Christopher)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Daniel)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Anna)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Benjamin)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Caroline)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Daniel)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Filipino (Anna)","lang":"fil-PH","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Anna)","lang":"id-ID","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Benjamin)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Indonesian (Christopher)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Anna)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Benjamin)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Christopher)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Diane)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Elizabeth)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Czech (Anna)","lang":"cs-CZ","gender":"female"},
    {"voiceName":"GoogleStandard Greek, Modern (Anna)","lang":"el-GR","gender":"female"},
    {"voiceName":"GoogleStandard Brazilian Portuguese (Anna)","lang":"pt-BR","gender":"female"},
    {"voiceName":"GoogleStandard Hungarian (Anna)","lang":"hu-HU","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Elizabeth)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Anna)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Benjamin)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Christopher)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Diane)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Slovak (Anna)","lang":"sk-SK","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Anna)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Benjamin)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Turkish (Caroline)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Diane)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Ethan)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Ukrainian (Anna)","lang":"uk-UA","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Anna)","lang":"en-IN","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Benjamin)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Indian English (Christopher)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Anna)","lang":"hi-IN","gender":"female"},
    {"voiceName":"GoogleStandard Hindi (Benjamin)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Christopher)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Danish (Anna)","lang":"da-DK","gender":"female"},
    {"voiceName":"GoogleStandard Finnish (Anna)","lang":"fi-FI","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Anna)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Benjamin)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Christopher)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Diane)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Elizabeth)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Anna)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Benjamin)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Caroline)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Daniel)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Swedish (Anna)","lang":"sv-SE","gender":"female"},
    {"voiceName":"GoogleStandard British English (Anna)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Benjamin)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard British English (Caroline)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Daniel)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard US English (Benjamin)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Caroline)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard US English (Daniel)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Elizabeth)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard German (Anna)","lang":"de-DE","gender":"female"},
    {"voiceName":"GoogleStandard German (Benjamin)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard German (Ethan)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Anna)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Benjamin)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Caroline)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Daniel)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Anna)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Benjamin)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Caroline)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Daniel)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard French (Anna)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Benjamin)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard French (Caroline)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Daniel)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Bianca)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Christopher)","lang":"it-IT","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Daniel)","lang":"it-IT","gender":"male"},
  ]
}


function IbmWatsonTtsEngine() {
  var isSpeaking = false;
  var audio, prefetchAudio;
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.voice)
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.voice)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return getSettings(["watsonVoices", "ibmCreds"])
      .then(function(items) {
        if (!items.ibmCreds) return [];
        if (items.watsonVoices && Date.now()-items.watsonVoices[0].ts < 24*3600*1000) return items.watsonVoices;
        return fetchVoices(items.ibmCreds.apiKey, items.ibmCreds.url)
          .then(function(list) {
            list[0].ts = Date.now();
            updateSettings({watsonVoices: list}).catch(console.error);
            return list;
          })
          .catch(function(err) {
            console.error(err);
            return [];
          })
      })
  }
  this.fetchVoices = fetchVoices;

  function getAudioUrl(text, voice) {
    assert(text && voice);
    var matches = voice.voiceName.match(/^IBM-Watson .* \((\w+)\)$/);
    var voiceName = voice.lang + "_" + matches[1] + "Voice";
    return getSettings(["ibmCreds"])
      .then(function(settings) {
        return ajaxGet({
          url: settings.ibmCreds.url + "/v1/synthesize?text=" + encodeURIComponent(escapeHtml(text)) + "&voice=" + encodeURIComponent(voiceName) + "&accept=" + encodeURIComponent("audio/ogg;codecs=opus"),
          headers: {
            Authorization: "Basic " + btoa("apikey:" + settings.ibmCreds.apiKey)
          },
          responseType: "blob"
        })
      })
      .then(function(blob) {
        return URL.createObjectURL(blob);
      })
  }
  function fetchVoices(apiKey, url) {
    return ajaxGet({
        url: url + "/v1/voices",
        headers: {
          Authorization: "Basic " + btoa("apikey:" + apiKey)
        }
      })
      .then(JSON.parse)
      .then(function(data) {
        return data.voices.map(item => {
          item.description = item.description.replace(/Chinese \((Mandarin|Cantonese)\)/, "Chinese, $1");
          return {
            voiceName: "IBM-Watson " + item.description.split(/: | male| female| \(/)[1] + " (" + item.name.slice(item.language.length+1, -5) + ")",
            lang: item.language,
            gender: item.gender,
          }
        })
      })
  }
}


function NvidiaRivaTtsEngine() {
  const RIVA_VOICE_PREFIX = "Nvidia-Riva "
  var prefetchAudio;
  var isSpeaking = false;
  var audio;
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice, options.pitch, options.rate);
      })
    // Rate supplied to player is always 1 because it is already represented in the generated audio
    audio = playAudio(urlPromise, {...options, rate: 1})
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice, options.pitch, options.rate)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return getSettings(["rivaVoices", "rivaCreds"])
      .then(function(items) {
        if (!items.rivaCreds) return [];
        if (items.rivaVoices && Date.now()-items.rivaVoices[0].ts < 24*3600*1000) return items.rivaVoices;
        return fetchVoices(items.rivaCreds.url)
          .then(function(list) {
            list[0].ts = Date.now();
            updateSettings({rivaVoices: list}).catch(console.error);
            return list;
          })
          .catch(function(err) {
            console.error(err);
            return [];
          })
      })
  }
  async function getAudioUrl(text, voice, pitch, rate) {
    assert(text && voice);
    const settings = await getSettings(["rivaCreds"])
    const res = await fetch(settings.rivaCreds.url + "/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "audio/ogg;codecs=opus"
      },
      body: JSON.stringify({
        voice: voice.voiceName.replace(RIVA_VOICE_PREFIX,''),
        text: escapeHtml(text),
        pitch,
        rate
      })
    })
    if (!res.ok) throw new Error("Server returns " + res.status)
    const blob = await res.blob()
    return URL.createObjectURL(blob);
  }
  this.fetchVoices = fetchVoices;
  function fetchVoices(url) {
    return ajaxGet({ url: url + "/voices" }).then(JSON.parse).then((voices)=>{
      return voices.map((v)=>({...v, voiceName:RIVA_VOICE_PREFIX+v.voiceName}))
    })
  }
}


function PhoneTtsEngine() {
  var isSpeaking = false
  var conn
  const pendingRequests = new Map()
  const getPairingCode = lazy(() => 100000 + Math.floor(Math.random() * 900000))
  const getPeer = lazy(async () => {
    const peer = new Peer("readaloud-" + getPairingCode(), {debug: 2})
    await new Promise((f,r) => peer.once("open", f).once("error", r))
    peer.on("connection", newConn => {
      const makeError = reason => new Error(JSON.stringify({code: "error_phone_disconnected", reason}))
      newConn.readyPromise = new Promise((fulfill, reject) => {
        newConn.once("open", fulfill)
          .once("error", err => reject(makeError(err.message || err)))
      })
      newConn.once("close", () => newConn.readyPromise = Promise.reject(makeError("Connection lost")))
      newConn.on("error", console.error)
      newConn.on("data", res => {
        const pending = pendingRequests.get(res.id)
        if (pending) {
          if (res.error) pending.reject(new Error(res.error))
          else pending.fulfill(res.value)
        }
        else {
          console.warn("Response received but no pending request", res)
        }
      })
      newConn.peerConnection.addEventListener("connectionstatechange", () => {
        //https://bugs.chromium.org/p/chromium/issues/detail?id=982793#c15
        if (newConn.peerConnection.connectionState == "failed") newConn.close()
      })
      if (conn) conn.close()
      conn = newConn
    })
    window.addEventListener("beforeunload", () => peer.destroy())
    return peer
  })
  this.startPairing = async function() {
    if (conn) {
      conn.close()
      conn = null
    }
    const peer = await getPeer()
    if (peer.disconnected) peer.reconnect()
    return getPairingCode()
  }
  this.isPaired = async function() {
    return conn != null
  }
  async function sendRequest(req, timeout) {
    req.id = String(Math.random())
    await conn.readyPromise
    conn.send(req)
    const responsePromise = new Promise((fulfill, reject) => pendingRequests.set(req.id, {fulfill, reject}))
    try {
      return await promiseTimeout(timeout || 5000, "Request timed out", responsePromise)
    }
    catch(err) {
      if (err.message == "Request timed out") {
        console.warn("Request timed out, assuming phone connection lost")
        conn.close()
      }
      throw err
    }
    finally {
      pendingRequests.delete(req.id)
    }
  }
  this.speak = function(text, options, onEvent) {
    if (!conn) {
      onEvent({type: "error", error: new Error(JSON.stringify({code: "error_phone_not_connected"}))})
      return
    }
    sendRequest({
        method: "speak",
        text,
        options: {
          lang: options.lang,
          rate: options.rate,
          pitch: options.pitch,
          volume: options.volume
        }
      })
      .then(({speechId}) => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true
        sendRequest({method: "waitFinish", speechId}, 3*60*1000)
          .then(() => onEvent({type: "end", charIndex: text.length}),
            err => {
              if (err.message != "interrupted") onEvent({type: "error", error: err})
            })
          .finally(() => isSpeaking = false)
      })
      .catch(err => {
        if (err.message != "canceled") onEvent({type: "error", error: err})
      })
  }
  this.stop = function() {
    if (!conn) return;
    sendRequest({method: "stop"}).catch(console.error)
  }
  this.pause = function() {
    sendRequest({method: "pause"}).catch(console.error)
  }
  this.resume = function() {
    sendRequest({method: "resume"}).catch(console.error)
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking)
  }
  this.getVoices = function() {
    return [
      {voiceName: "Use My Phone", remote: false, isUseMyPhone: true},
    ]
  }
}


function OpenaiTtsEngine() {
  var audio, prefetchAudio
  var isSpeaking = false
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.voice, options.pitch)
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true
      })
      .catch(err => {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking)
  }
  this.pause =
  this.stop = function() {
    audio.pause()
  }
  this.resume = function() {
    return audio.resume()
  }
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.voice, options.pitch)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  }
  this.setNextStartTime = function() {
  }
  this.getVoices = function() {
    return voices
  }
  async function getAudioUrl(text, voice, pitch) {
    assert(text && voice)
    console.log(voice);
    const matches = voice.voiceName.match(/^ChatGPT .* \((\w+)\)$/)
    const voiceName = "123"
    const {openaiCreds} = await getSettings(["openaiCreds"])
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + openaiCreds.apiKey
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: voiceName,
        response_format: "opus",
      })
    })

    // console.log("444444")

    // const res = await fetch("http://localhost:9880?refer_wav_path=E:/work/GPT-SoVITS-0211/output/slicer_opt/Keira.wav_0000000000_0000131840.wav&prompt_text=光动嘴不如亲自做给你看，等我一下啊&prompt_language=中文&text_language=中文&text=你好你好，这里是测试", {
    //   method: "GET"

    // })

    // console.log(res);

    
    if (!res.ok) throw await res.json().then(x => x.error)
    return URL.createObjectURL(await res.blob())
  }
  const voices = [
    {"voiceName":"ChatGPT English (alloy)","lang":"en-US","gender":"female"},
    {"voiceName":"ChatGPT English (echo)","lang":"en-US","gender":"male"},
    {"voiceName":"ChatGPT English (fable)","lang":"en-US","gender":"female"},
    {"voiceName":"ChatGPT English (onyx)","lang":"en-US","gender":"male"},
    {"voiceName":"ChatGPT English (nova)","lang":"en-US","gender":"female"},
    {"voiceName":"ChatGPT English (shimmer)","lang":"en-US","gender":"female"},
  ]
}


function AzureTtsEngine() {
  var isSpeaking = false;
  var audio, prefetchAudio;
  this.speak = function(utterance, options, onEvent) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.lang, options.voice)
      })
    audio = playAudio(urlPromise, options)
    audio.startPromise
      .then(() => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true;
      })
      .catch(function(err) {
        onEvent({type: "error", error: err})
      })
    audio.endPromise
      .then(() => onEvent({type: "end", charIndex: utterance.length}),
        err => onEvent({type: "error", error: err}))
      .finally(() => isSpeaking = false)
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    audio.pause()
  };
  this.resume = function() {
    return audio.resume()
  };
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.lang, options.voice)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = async function() {
    try {
      const {azureCreds, azureVoices} = await getSettings(["azureCreds", "azureVoices"])
      if (!azureCreds) return []
      if (azureVoices && azureVoices.expire > Date.now()) return azureVoices.list
      const list = await this.fetchVoices(azureCreds.region, azureCreds.key)
      await updateSettings({azureVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  this.fetchVoices = async function(region, key) {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
      }
    })
    if (!res.ok) throw new Error("Server return " + res.status)
    const voices = await res.json()
    return voices.map(item => {
      const name = item.ShortName.split("-")[2]
      return {
        voiceName: "Azure " + item.LocaleName + " - " + name,
        lang: item.Locale,
        gender: item.Gender == "Male" ? "male" : "female",
      }
    })
  }
  async function getAudioUrl(text, lang, voice) {
    const matches = voice.voiceName.match(/^Azure .* - (\w+)$/)
    const voiceName = voice.lang + "-" + matches[1]
    const {azureCreds} = await getSettings(["azureCreds"])
    const {region, key} = azureCreds
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "ogg-48khz-16bit-mono-opus",
      },
      body: `<speak version='1.0' xml:lang='${lang}'><voice name='${voiceName}'>${escapeXml(text)}</voice></speak>`
    })
    if (!res.ok) throw new Error("Server return " + res.status)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }
}
