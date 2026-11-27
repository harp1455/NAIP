/**
 * 에셋 제작 모드 (캐릭터 챗용 이미지 대량 제작) — 데이터 모델과 순수 엔진.
 *
 * 흐름: 프로젝트(types·model·store) → 행렬 펼치기·계획(matrix) → 생성 대기열(리드가 GenerationJob을 배치로)
 * → 히스토리 이미지에 분류 표시(ProjectImageTag) → 선별(curation) → 내보내기 계획(export·template)
 * → 변환(convert) → 저장 + 목록(manifest). 외부 그림은 classify로 조합에 배정할 수 있다.
 */
export * from './types'
export * from './model'
export * from './curation'
export * from './matrix'
export * from './template'
export * from './manifest'
export * from './export'
export * from './classify'
export * from './convert'
export * from './presets'
export { useProjects, activeProject } from './store'
