// Clearsky page: spelling in the chat box. The browser underlines misspelt words (spellcheck is
// on for the box, right-click for its suggestions). The Auto-fix check by the box also corrects
// common typos as you type: the word before a space or punctuation, and the last word on send.
// It runs here in the page with a fixed list, no dictionary or service. It leaves code alone
// (`inline`, ``` blocks, indented lines, $ commands) and anything that isn't a plain word:
// paths, links, @refs, /skills, flags, names with capitals or digits inside.
// Backspace right after a fix puts the word back; Ctrl+Z works too.

const SPELL_FIXES = Object.fromEntries(`
abotu about|aobut about|accomodate accommodate|accross across|acheive achieve|adn and|adress address
agian again|ahve have|allways always|alot a lot|alredy already|amoung among|apparantly apparently
aquire acquire|arent aren't|arguement argument|aswell as well|basicly basically|beacuse because
beatiful beautiful|becasue because|becuase because|becuse because|befor before|beggining beginning
begining beginning|beleive believe|belive believe|branhc branch|brnach branch|buisness business
cahnge change|calender calendar|carefull careful|chagne change|cheking checking|chnage change
choosen chosen|comit commit|comittee committee|commited committed|commiting committing|commmit commit
commti commit|comming coming|completly completely|concious conscious|configuraiton configuration
couldnt couldn't|databse database|datbase database|definately definitely|defintely definitely
definitly definitely|dependancies dependencies|dependancy dependency|deploymnet deployment|deplyo deploy
depricated deprecated|desicion decision|didnt didn't|differnt different|diffrent different
dissapear disappear|doesnt doesn't|dont don't|eachother each other|embarass embarrass
enviornment environment|envirnoment environment|enviroment environment|exisiting existing
existant existent|explaination explanation|exsiting existing|familar familiar|finaly finally
foward forward|freind friend|fucntion function|funciton function|functoin function|gaurd guard
goverment government|hadnt hadn't|happend happened|harrass harass|hasnt hasn't|havent haven't
heigth height|heres here's|hieght height|hte the|hvae have|im I'm|immediatly immediately
implemenation implementation|implment implement|implmentation implementation|independant independent
infomation information|initalize initialize|intial initial|interupt interrupt|intresting interesting
isnt isn't|ive I've|jsut just|knowlege knowledge|knwo know|konw know|lenght length|lenth length
liason liaison|libary library|lisence license|maintainance maintenance|maintenence maintenance
managment management|mergeing merging|mesage message|messsage message|millenium millennium
mispell misspell|nad and|neccesary necessary|neccessary necessary|necesary necessary|nkow know
noticable noticeable|occassion occasion|occurence occurrence|occured occurred|occuring occurring
ocurred occurred|offical official|oppurtunity opportunity|owrk work|paramter parameter
paramters parameters|peice piece|pelase please|perfomance performance|performace performance
persistant persistent|plase please|posible possible|possibilty possibility|prefered preferred
presense presence|privelege privilege|priviledge privilege|probaly probably|probelm problem
problme problem|procces process|proccess process|programatically programmatically|publically publicly
questionaire questionnaire|reccomend recommend|reciept receipt|recieve receive|recieved received
recomend recommend|recommand recommend|refered referred|refering referring|reivew review
relevent relevant|remeber remember|rember remember|repositry repository|reposiotry repository
repostiory repository|reqeust request|requets request|respone response|responce response
resposne response|retrun return|reutrn return|reveiw review|reviwe review|reuqest request
runing running|schmea schema|sentance sentence|seperate separate|seperately separately
serivce service|servcie service|sevice service|shcema schema|shoud should|shoudl should
shouldnt shouldn't|similiar similar|simliar similar|sincerly sincerely|soemthing something
somthing something|sucess success|succesful successful|successfull successful|sucessful successful
supress suppress|suprise surprise|taht that|teh the|tets test|thats that's|theres there's
theyre they're|thier their|thnaks thanks|thsi this|ticekt ticket|tihs this|tikcet ticket|tje the
togehter together|tomorow tomorrow|tommorow tomorrow|tommorrow tomorrow|truely truly|tset test
udpate update|untill until|upadte update|updaet update|usefull useful|varaible variable
variabel variable|wasnt wasn't|waht what|wehn when|werent weren't|wether whether|whats what's
whcih which|whereever wherever|whith with|wich which|widht width|wierd weird|wiht with|wnat want
wokring working|wouldnt wouldn't|writen written|writting writing|wrok work|wroking working
yeild yield|youre you're|yoru your|yuo you
`.trim().split(/[|\n]/).map((p) => p.trim().split(' ')).map(([k, ...v]) => [k, v.join(' ')]));

// The fix for one word, in the word's own case, or null. Only plain lower-case, Capitalised
// or a lone "i" is touched: ALLCAPS, camelCase and anything with digits or symbols is left as is.
function spellFix(word) {
  if (word === 'i') return 'I';
  if (!/^[A-Za-z]+$/.test(word) || !/^[A-Za-z][a-z]*$/.test(word)) return null;
  const fix = SPELL_FIXES[word.toLowerCase()];
  if (!fix) return null;
  return word[0] === word[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
}

// Is the end of this text inside code? ``` blocks, `inline` code (an open one counts until it
// closes), lines indented four spaces or a tab, and lines that start with "$ " or "> $".
function spellInCode(text) {
  if ((text.match(/^\s*```/gm) || []).length % 2) return true;
  const line = text.slice(text.lastIndexOf('\n') + 1);
  if (/^( {4}|\t)/.test(line) || /^\s*(>\s*)?\$\s/.test(line)) return true;
  const prose = text.replace(/^\s*```[\s\S]*?^\s*```/gm, '');
  return (prose.slice(prose.lastIndexOf('\n') + 1).match(/`/g) || []).length % 2 === 1;
}

// The fix for the word that ends at `end` in `text`: { start, end, from, to } or null. The word
// is the run of non-space characters before `end`, less leading quotes or brackets and trailing
// punctuation; if what's left isn't a plain word (a path, a link, a flag, @ or /), nothing changes.
function spellFixAt(text, end) {
  const before = text.slice(0, end);
  const tok = before.match(/\S+$/)?.[0];
  if (!tok) return null;
  const core = tok.replace(/^["'(\[]+/, '').replace(/[.,;:!?)\]"']+$/, '');
  const lead = tok.length - tok.replace(/^["'(\[]+/, '').length;
  if (!core || /[^A-Za-z]/.test(core)) return null;
  const start = end - tok.length + lead;
  const to = spellFix(core);
  if (!to || spellInCode(text.slice(0, start))) return null;
  return { start, end: start + core.length, from: core, to };
}

const AUTOFIX_KEY = 'clearsky.autofix';
const autofixBox = $('#cp-autofix');
try { autofixBox.checked = localStorage.getItem(AUTOFIX_KEY) === '1'; } catch {}
autofixBox.addEventListener('change', () => { try { localStorage.setItem(AUTOFIX_KEY, autofixBox.checked ? '1' : ''); } catch {} });

const spellKept = new Set(); // words you put back with Backspace: not fixed again
let lastFix = null; // { at, from, to, value }: the fix Backspace can take back
let fixNoteTimer;
// Swap a range of the box's text through the browser's edit commands, so Ctrl+Z undoes it.
function spellReplace(ta, start, end, text) {
  const caret = ta.selectionStart;
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, start, end, 'end');
  const at = caret + text.length - (end - start);
  ta.setSelectionRange(at, at);
}
// Show the fix on the check's label for a moment, so a change never goes unseen.
function spellNote(text) {
  const label = $('#cp-autofix-label');
  label.textContent = text;
  clearTimeout(fixNoteTimer);
  fixNoteTimer = setTimeout(() => { label.textContent = 'Auto-fix'; }, 2500);
}
// Fix the word that ends at `end` (before the space just typed, or at the end of the box).
function autoFixWord(ta, end) {
  const f = spellFixAt(ta.value, end);
  if (!f || spellKept.has(f.from)) return false;
  spellReplace(ta, f.start, f.end, f.to);
  lastFix = { at: ta.selectionStart, from: f.from, to: f.to, start: f.start, value: ta.value };
  spellNote(`${f.from} → ${f.to}`);
  return true;
}
// Before a message goes: the last word has no space after it yet, so fix it here.
function autoFixLast(ta) {
  if (!autofixBox.checked) return;
  const end = ta.value.replace(/[\s.,;:!?)\]"']+$/, '').length;
  autoFixWord(ta, end);
}
$('#chat-text').addEventListener('input', (e) => {
  const ta = e.target;
  if (lastFix && ta.value !== lastFix.value) lastFix = null;
  if (!autofixBox.checked || e.isComposing) return;
  const typed = e.inputType === 'insertLineBreak' ? '\n' : e.inputType === 'insertText' ? e.data : null;
  if (!typed || !/^[\s.,;:!?)\]"']$/.test(typed) || ta.selectionStart !== ta.selectionEnd) return;
  autoFixWord(ta, ta.selectionStart - 1);
});
// Backspace straight after a fix puts the typed word back (and keeps the space).
$('#chat-text').addEventListener('keydown', (e) => {
  const ta = e.target;
  if (e.key !== 'Backspace' || !lastFix || ta.value !== lastFix.value || ta.selectionStart !== lastFix.at || ta.selectionEnd !== lastFix.at) return;
  e.preventDefault();
  const { start, to, from } = lastFix;
  lastFix = null;
  spellKept.add(from);
  ta.setSelectionRange(start, start + to.length);
  if (!document.execCommand('insertText', false, from)) ta.setRangeText(from, start, start + to.length, 'end');
  const at = start + from.length + (ta.value.length - start - from.length > 0 && /[\s.,;:!?)\]"']/.test(ta.value[start + from.length]) ? 1 : 0);
  ta.setSelectionRange(at, at);
  spellNote(`Kept ${from}`);
});
