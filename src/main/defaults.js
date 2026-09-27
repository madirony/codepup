// 기본 설정값과 커스텀 가능한 이미지/사운드 슬롯 정의.
// 슬롯의 기본 파일은 현재 스킨(skin.json)이 정하고, 사용자가 슬롯별로 덮어쓸 수 있어요.

const IMAGE_SLOTS = [
  { key: 'default', label: '기본 (걷기)' },
  { key: 'happy', label: '행복 · 쓰다듬기' },
  { key: 'alert', label: '작업 끝 알림' },
  { key: 'worry', label: '허락 요청' },
  { key: 'eat', label: '냠냠 (먹기)' },
  { key: 'sleep', label: '잠' },
  { key: 'hungry', label: '배고픔' },
  { key: 'tired', label: '졸림' },
  { key: 'carry', label: '들렸을 때' },
  { key: 'run', label: '질주 (CPU 과부하)' },
  { key: 'dizzy', label: '어지러움' },
  { key: 'sing', label: '노래' },
  { key: 'annoyed', label: '화남' },
  { key: 'levelup', label: '레벨 업' },
  { key: 'food', label: '밥' },
];

const SOUND_SLOTS = [
  { key: 'greet', label: '인사' },
  { key: 'done', label: 'Claude 작업 끝 알림' },
  { key: 'permission', label: 'Claude 허락 요청 알림' },
  { key: 'happy', label: '쓰다듬기 · 기쁨' },
  { key: 'chatter', label: '혼잣말' },
  { key: 'eat', label: '먹기' },
  { key: 'hungry', label: '배고파요' },
  { key: 'carry', label: '들었을 때' },
  { key: 'flung', label: '던졌을 때' },
  { key: 'annoyed', label: '마구 클릭했을 때' },
  { key: 'sing', label: '노래' },
  { key: 'levelup', label: '레벨 업' },
  { key: 'wake', label: '잠에서 깼을 때' },
];

const DEFAULT_PHRASES = ['멍!', '오늘도 코딩 화이팅!', '같이 놀아요~', '헤헤', '간식 주세요!', '꼬리 흔들흔들~'];

const DEFAULT_SETTINGS = {
  name: '초코',
  skin: 'chihuahua',
  size: 75, // 화면에 보이는 키(px)
  speed: 1.0, // 이동 속도 배율
  moveMode: 'free', // 'free' = 화면 전체, 'ground' = 화면 아래쪽만
  soundEnabled: true,
  volume: 0.6,
  ambientSounds: true, // 혼잣말·노래처럼 스스로 내는 소리
  bubbles: true, // 말풍선
  phrases: DEFAULT_PHRASES,
  cpuReactive: true, // CPU 사용률에 따라 빨라지기
  sprintThreshold: 70, // 이 CPU %를 넘으면 전력 질주
  idleSleep: true, // 컴퓨터를 안 쓰면 낮잠
  idleSleepMinutes: 10,
  showOnFullscreen: false,
  launchAtLogin: false,
  hidden: false,
  tray: { cpu: true, mem: false, disk: false, battery: false, animate: true, sessions: true, limits: true },
  // Claude Code 연동
  awayMode: false, // 자리 비움: 작업이 끝나면 펫에서 다음 지시를 기다림
  permissionWaitSec: 60, // 펫에서 권한 요청에 답할 수 있는 시간 (지나면 터미널 창으로)
  replyWaitMin: 30, // 자리 비움 모드에서 기다리는 시간
  restoreRemoteControl: true, // 세션 복구 시 --rc (원격 제어) 켜기
  restoreTerminal: 'auto', // 'auto' | 'Terminal' | 'iTerm'
  restoreExtraArgs: '',
  taskModel: '', // 펫이 직접 실행하는 작업의 모델 ('' = 내 Claude Code 기본 모델)
  customImages: {}, // slotKey -> user-media 파일 이름
  customSounds: {},
};

module.exports = { IMAGE_SLOTS, SOUND_SLOTS, DEFAULT_SETTINGS, DEFAULT_PHRASES };
