/**
 * Compact blocklist of the passwords people actually pick.
 *
 * This is the top slice, kept inline so there's no file-read on the signup path.
 * To use the full 10k list from PLAN.md §11.1, drop SecLists'
 * `10-million-password-list-top-10000.txt` into `packages/auth/data/`, read it
 * once at module load, and union it into this Set — the call sites don't change.
 */
const LIST = `
123456 password 123456789 12345678 12345 qwerty abc123 111111 1234567 password1
1234567890 123123 000000 iloveyou 1234 1q2w3e4r5t qwertyuiop 123 monkey dragon
123456a 654321 123321 666666 1qaz2wsx myspace1 121212 homelesspa 123qwe a123456
123abc 1q2w3e4r qwe123 7777777 qwerty123 target123 tinkle987654321 gwerty123
zag12wsx 1g2w3e4r gwerty jordan23 password123 g_czechout asdfghjkl 1q2w3e
football baseball welcome abc12345 letmein monkey123 shadow master superman
sunshine princess trustno1 batman passw0rd zaq12wsx michael computer jessica
pepper daniel hannah thomas summer george charlie andrew michelle jennifer
hunter buster soccer harley ranger joshua maggie startrek matthew access
flower hello freedom whatever nicole ginger heather hammer purple andrea
horny dakota aaaaaa player sunset chicken diamond matrix cookie orange
chelsea lovely secret sparky friend bailey mother mustang liverpool arsenal
chocolate internet samsung nothing tigger asdfgh zxcvbnm qazwsx 987654321
qwertyui asdasd 555555 888888 999999 112233 789456 iloveu lol123 test123
admin admin123 root toor guest login pass secret changeme default temp
student school college university homework study studying notes exam final
p@ssw0rd passw0rd1 letmein123 welcome123 iloveyou1 sunshine1 princess1
qwerty1 abcd1234 a1b2c3d4 asdf1234 zxcv1234 1qaz2wsx3edc trustno1234
studytogether studytogether1 syncstudy syncstudy1 studygroup studybuddy
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  LIST.split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
);
