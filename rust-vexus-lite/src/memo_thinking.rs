#![allow(dead_code)]

//! Read-only method-module planning over one existing Sense observation.
//! This is a propagation-supported scaffold, not a formal proof.
use crate::memo_sensing::ObservationTransition;
use crate::rivermemo_topology_v3::{load_artifact_with_connection, MemoRuntime, NativeArtifact};
use crate::storage::with_registered_read_transaction;
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    diary_name: String,
    k: usize,
    candidate_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    observation_handle: String,
    stages: Vec<Stage>,
    #[serde(default = "default_closure")]
    min_closure: f64,
    #[serde(default = "default_true")]
    enable_viterbi_lookahead: bool,
    #[serde(default = "default_true")]
    enable_homotopy_relay: bool,
    #[serde(default = "default_true")]
    enable_grassmann_stage_resonance: bool,
    #[serde(default = "default_true")]
    enable_diagnostics: bool,
}

fn default_closure() -> f64 {
    0.2
}

fn default_true() -> bool {
    true
}
#[derive(Clone)]
struct Module {
    id: i64,
    file_id: i64,
    relevance: f64,
    tags: HashMap<i64, (usize, f64)>,
    ordered_tags: Vec<(i64, usize, f64)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    chunk_id: i64,
    score: f64,
    parents: Vec<i64>,
    relation: &'static str,
    route: Option<ObservationTransition>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageOutput {
    diary_name: String,
    k: usize,
    results: Vec<Selection>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizationHint {
    stage: String,
    module_id: i64,
    bottleneck: &'static str,
    potential_score_gain: f64,
    source_tag_id: i64,
    target_tag_id: i64,
    prescription: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatentWormhole {
    from_stage: String,
    to_stage: String,
    from_module_id: i64,
    to_module_id: i64,
    source_tag_id: i64,
    target_tag_id: i64,
    structural_cosine: f64,
    sweet_spot_gain: f64,
    inspiration_potential: f64,
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum();
    let aa: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum();
    let bb: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum();
    let value = dot / (aa * bb).sqrt();
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn decode(bytes: Vec<u8>, dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return None;
    }
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    values.iter().all(|v| v.is_finite()).then_some(values)
}

/// Adjacency requires the actual time-expanded predecessor state, not Tag
/// reachability in the aggregated river. Immediate return is never progression.
fn follows(left: &ObservationTransition, right: &ObservationTransition) -> bool {
    !right.immediate_return
        && left.hop + 1 == right.hop
        && left.target_id == right.source_id
        && right.previous_id == Some(left.source_id)
}

/// V9 Homotopy Continuation Kernel:
/// 1) Returns `Some(1.0)` when strict `follows(left, right)` holds;
/// 2) When `enable_homotopy_relay` is enabled and `right` advances in hop depth without folding back,
///    awards a soft relay factor in `[0.60, 0.92]` if `left.target_id -> right.source_id` is bridged
///    by a directed graph edge (`w >= 0.08`) or high-dimensional tangent cosine (`sim >= 0.72`).
fn homotopy_continuation_factor(
    left: &ObservationTransition,
    right: &ObservationTransition,
    enable_homotopy_relay: bool,
    artifact: &NativeArtifact,
    global_tag_vecs: &HashMap<i64, (Arc<[f32]>, f64)>,
) -> Option<f64> {
    if follows(left, right) {
        return Some(1.0);
    }
    if !enable_homotopy_relay || right.immediate_return {
        return None;
    }
    if right.hop < left.hop
        || right.hop > left.hop + 2
        || right.target_id == left.source_id
        || right.source_id == left.source_id
    {
        return None;
    }
    if left.target_id == right.source_id && right.hop > left.hop {
        return Some(0.92);
    }
    let graph_bridge = artifact.edge_weight(left.target_id, right.source_id);
    if graph_bridge >= 0.08 {
        return Some((0.80 + 0.12 * graph_bridge.min(1.0)).min(0.90));
    }
    if let (Some((u_vec, u_norm)), Some((v_vec, v_norm))) = (
        global_tag_vecs.get(&left.target_id),
        global_tag_vecs.get(&right.source_id),
    ) {
        if *u_norm > 1e-12 && *v_norm > 1e-12 && u_vec.len() == v_vec.len() {
            let dot: f64 = u_vec
                .iter()
                .zip(v_vec.iter())
                .map(|(&a, &b)| (a as f64) * (b as f64))
                .sum();
            let sim = dot / (u_norm * v_norm);
            if sim >= 0.72 {
                return Some((0.85 * sim).clamp(0.60, 0.88));
            }
        }
    }
    None
}
pub(crate) fn plan(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let _guard = crate::publication_gate::acquire_read(db_path, &[String::from("*")])?;
    let input: Input = serde_json::from_str(input_json).map_err(|e| e.to_string())?;
    if input.stages.is_empty()
        || input.stages.len() > 32
        || !input.min_closure.is_finite()
        || !(0.0..=1.0).contains(&input.min_closure)
        || input
            .stages
            .iter()
            .any(|s| s.k > 32 || s.candidate_ids.len() > 256 || s.diary_name.trim().is_empty())
    {
        return Err("invalid or oversized method planning request".into());
    }
    let cached = runtime.get_query_observation(&input.observation_handle, artifact_sig)?;
    let observation = &cached.observation;
    if observation.transitions.is_empty() || observation.transitions_truncated {
        return Err("Sense transitions unavailable or truncated".into());
    }
    let dimension = cached.original_query_vector.len();
    with_registered_read_transaction(db_path, |connection| {
        let artifact = load_artifact_with_connection(runtime, connection, artifact_sig)?;
        let mut chunk_statement = connection
            .prepare(
                "SELECT c.file_id, c.vector FROM chunks c JOIN files f ON f.id=c.file_id
             WHERE c.id=?1 AND f.diary_name=?2 AND c.vector IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let mut tag_statement = connection
            .prepare(
                "SELECT ft.tag_id, t.vector FROM file_tags ft JOIN tags t ON t.id=ft.tag_id
             WHERE ft.file_id=?1 AND t.vector IS NOT NULL ORDER BY ft.position, ft.tag_id LIMIT 128",
            )
            .map_err(|e| e.to_string())?;
        let maximum_flow = observation
            .transitions
            .iter()
            .map(|e| e.flow)
            .fold(0.0, f64::max);
        // Direction B (Per-Hop Layer Peak Normalization):
        // Prevent Hop-1 dominant flow from crushing Hop-2/3/4 multi-hop continuations.
        // Blend 50% global flow ratio + 50% per-hop peak flow ratio so deep hops compete fairly
        // while preserving monotone flow preference within the same hop.
        let mut max_flow_by_hop: HashMap<usize, f64> = HashMap::new();
        for e in &observation.transitions {
            if !e.immediate_return {
                let entry = max_flow_by_hop.entry(e.hop).or_insert(0.0);
                if e.flow > *entry {
                    *entry = e.flow;
                }
            }
        }

        // Direction A (4-Way Fused Multi-Field Envelope Relevance):
        // Measure module relevance against original, enhanced, local, and transfer field vectors
        // in a single pass so abstract philosophical modules resonate with cross-domain transfer intent.
        let q_orig = cached.original_query_vector.as_ref();
        let q_enh = cached.enhanced_query_vector.as_ref();
        let q_loc = cached.local_vector.as_ref();
        let q_trf = cached.transfer_vector.as_ref();
        let norm_orig = q_orig.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        let norm_enh = if q_enh.len() == dimension {
            q_enh.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };
        let norm_loc = if q_loc.len() == dimension {
            q_loc.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };
        let norm_trf = if q_trf.len() == dimension {
            q_trf.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };

        // V9 Grassmannian Stiefel Frame U \in St(M+1, d) for Multi-Pole Stage Resonance:
        let grassmann_poles: Vec<Vec<f32>> = if input.enable_grassmann_stage_resonance {
            let mut basis: Vec<Vec<f64>> = Vec::new();
            for pole in cached.transfer_basin_vectors.iter().take(4) {
                if pole.len() != dimension {
                    continue;
                }
                let mut v: Vec<f64> = pole.iter().map(|&x| x as f64).collect();
                for b in &basis {
                    let dot_p: f64 = v.iter().zip(b.iter()).map(|(a, b_val)| a * b_val).sum();
                    for (vi, &bi) in v.iter_mut().zip(b.iter()) {
                        *vi -= dot_p * bi;
                    }
                }
                let n: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
                if n > 0.15 {
                    for vi in &mut v {
                        *vi /= n;
                    }
                    basis.push(v);
                }
            }
            basis
                .into_iter()
                .map(|b| b.into_iter().map(|x| x as f32).collect())
                .collect()
        } else {
            Vec::new()
        };

        // Audit P1-4 Hard Budgets: cap unique cached tag vectors and active transition evaluations.
        const MAX_CACHED_UNIQUE_TAGS: usize = 4096;
        const MAX_ACTIVE_TRANSITIONS: usize = 1024;
        let active_transitions: &[ObservationTransition] = if observation.transitions.len() > MAX_ACTIVE_TRANSITIONS {
            &observation.transitions[..MAX_ACTIVE_TRANSITIONS]
        } else {
            &observation.transitions
        };
        let mut file_tags_cache: HashMap<i64, Vec<(usize, i64)>> = HashMap::new();
        let mut global_tag_vecs: HashMap<i64, (Arc<[f32]>, f64)> = HashMap::new();
        for (&tid, vec_arc) in cached.tag_vectors.iter().take(MAX_CACHED_UNIQUE_TAGS) {
            if vec_arc.len() == dimension {
                let norm = vec_arc.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                if norm > 1e-12 {
                    global_tag_vecs.insert(tid, (vec_arc.clone(), norm));
                }
            }
        }
        let mut stage_modules: Vec<(Stage, Vec<Module>)> = Vec::with_capacity(input.stages.len());

        // Preload all stages so we can compute Backward Viterbi Continuation Potential \beta_s(edge)
        for stage in input.stages {
            let mut modules = Vec::new();
            let mut seen = HashSet::new();
            for &id in &stage.candidate_ids {
                if id <= 0 || !seen.insert(id) {
                    continue;
                }
                let row = chunk_statement.query_row(rusqlite::params![id, stage.diary_name], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                });
                let (file_id, bytes) = match row {
                    Ok(row) => row,
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(error) => return Err(error.to_string()),
                };
                let Some(vector) = decode(bytes, dimension) else {
                    continue;
                };
                let v_norm = vector.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                let cached_tags = match file_tags_cache.entry(file_id) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let rows = tag_statement
                            .query_map([file_id], |r| {
                                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                            })
                            .map_err(|e| e.to_string())?;
                        let mut positions = Vec::new();
                        for (position, row) in rows.enumerate() {
                            let (tag_id, bytes) = row.map_err(|e| e.to_string())?;
                            if !global_tag_vecs.contains_key(&tag_id) {
                                if let Some(tag_vector) = decode(bytes, dimension) {
                                    let t_norm = tag_vector.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                                    if t_norm > 1e-12 && global_tag_vecs.len() < MAX_CACHED_UNIQUE_TAGS {
                                        global_tag_vecs.insert(tag_id, (Arc::from(tag_vector), t_norm));
                                    }
                                }
                            }
                            if global_tag_vecs.contains_key(&tag_id) {
                                positions.push((position, tag_id));
                            }
                        }
                        entry.insert(positions)
                    }
                };
                let mut tags = HashMap::with_capacity(cached_tags.len());
                let mut ordered_tags = Vec::with_capacity(cached_tags.len());
                for &(position, tag_id) in cached_tags.iter() {
                    let Some(&(ref tag_vector, t_norm)) = global_tag_vecs.get(&tag_id) else {
                        continue;
                    };
                    let dot: f64 = vector.iter().zip(tag_vector.iter()).map(|(x, y)| *x as f64 * *y as f64).sum();
                    let val = dot / (v_norm * t_norm).max(1e-12);
                    let closure_val = if val.is_finite() { val.clamp(0.0, 1.0) } else { 0.0 };
                    tags.insert(tag_id, (position, closure_val));
                    ordered_tags.push((tag_id, position, closure_val));
                }
                let relevance = if v_norm > 1e-12 && vector.len() == dimension && !vector.is_empty() {
                    let (mut d_orig, mut d_enh, mut d_loc, mut d_trf) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
                    let has_enh = norm_enh > 1e-12;
                    let has_loc = norm_loc > 1e-12;
                    let has_trf = norm_trf > 1e-12;
                    for i in 0..dimension {
                        let vi = vector[i] as f64;
                        d_orig += vi * (q_orig[i] as f64);
                        if has_enh {
                            d_enh += vi * (q_enh[i] as f64);
                        }
                        if has_loc {
                            d_loc += vi * (q_loc[i] as f64);
                        }
                        if has_trf {
                            d_trf += vi * (q_trf[i] as f64);
                        }
                    }
                    let c_orig = if norm_orig > 1e-12 { (d_orig / (v_norm * norm_orig)).clamp(0.0, 1.0) } else { 0.0 };
                    let c_enh = if has_enh { (d_enh / (v_norm * norm_enh)).clamp(0.0, 1.0) } else { c_orig };
                    let c_loc = if has_loc { (d_loc / (v_norm * norm_loc)).clamp(0.0, 1.0) } else { c_orig };
                    let mut c_trf = if has_trf { (d_trf / (v_norm * norm_trf)).clamp(0.0, 1.0) } else { c_orig };
                    if !grassmann_poles.is_empty() {
                        let mut chordal_sq = 0.0f64;
                        for (p_idx, pole) in grassmann_poles.iter().enumerate() {
                            let p_cos = cosine(&vector, pole);
                            if p_cos > c_trf {
                                c_trf = p_cos;
                            }
                            chordal_sq += (1.0 / (1.0 + 0.25 * p_idx as f64)) * p_cos * p_cos;
                        }
                        c_trf = c_trf.max(chordal_sq.sqrt().min(1.0));
                    }
                    let multi_env = 0.45 * c_orig + 0.25 * c_enh + 0.15 * c_loc + 0.15 * c_trf;
                    c_orig.max(multi_env)
                } else {
                    0.0
                };
                modules.push(Module {
                    id,
                    file_id,
                    tags,
                    ordered_tags,
                    relevance,
                });
            }
            stage_modules.push((stage, modules));
        }

        // Direction C (Backward Viterbi Continuation Envelope \beta):
        // Precompute for each transition edge in stage s whether and how strongly it can be
        // continued by any valid module in stage s + 1. This prevents stage-1 greedy lock-in
        // on dead-end edges when a slightly lower edge unlocks a multi-stage causal chain.
        let num_stages = stage_modules.len();
        let num_transitions = active_transitions.len();
        let mut stage_edge_best_intrinsic: Vec<Vec<f64>> = vec![vec![0.0; num_transitions]; num_stages];
        if input.enable_viterbi_lookahead {
            for (s_idx, (_, modules)) in stage_modules.iter().enumerate() {
                for (e_idx, edge) in active_transitions.iter().enumerate() {
                    if edge.immediate_return {
                        continue;
                    }
                    let hop_max = max_flow_by_hop.get(&edge.hop).copied().unwrap_or(maximum_flow).max(1e-12);
                    let flow_norm = 0.5 * (edge.flow / maximum_flow.max(1e-12)) + 0.5 * (edge.flow / hop_max);
                    let ricci_gain = 0.85 + 0.15 * artifact.edge_ricci_factor(edge.source_id, edge.target_id);
                    let mut best_mod_score = 0.0f64;
                    for m in modules {
                        if let (Some((a_pos, a_c)), Some((b_pos, b_c))) = (
                            m.tags.get(&edge.source_id),
                            m.tags.get(&edge.target_id),
                        ) {
                            if *a_pos < *b_pos && *a_c >= input.min_closure && *b_c >= input.min_closure {
                                let ind = artifact.independent_fraction(edge.source_id, edge.target_id, m.file_id);
                                let sc = flow_norm * (a_c * b_c).sqrt() * ind * ricci_gain;
                                if sc > best_mod_score {
                                    best_mod_score = sc;
                                }
                            }
                        }
                    }
                    stage_edge_best_intrinsic[s_idx][e_idx] = best_mod_score;
                }
            }
        }

        // Build predecessor adjacency index `(hop, previous_id, source_id) -> Vec<next_e_idx>`
        // so Backward Viterbi DP evaluates only valid causal successors instead of O(S * |T|^2) all-pairs scans!
        let mut next_edges_by_pred: HashMap<(usize, Option<i64>, i64), Vec<usize>> = HashMap::new();
        if input.enable_viterbi_lookahead {
            for (next_e_idx, next_edge) in active_transitions.iter().enumerate() {
                if !next_edge.immediate_return && next_edge.hop > 1 {
                    next_edges_by_pred
                        .entry((next_edge.hop, next_edge.previous_id, next_edge.source_id))
                        .or_default()
                        .push(next_e_idx);
                }
            }
        }

        // Backward DP sweep: beta[s][e_idx] = max future continuation chain value from stage s+1..num_stages
        let mut beta_lookahead: Vec<Vec<f64>> = vec![vec![0.0; num_transitions]; num_stages];
        if input.enable_viterbi_lookahead && num_stages >= 2 {
            for s_idx in (0..num_stages - 1).rev() {
                if stage_modules[s_idx + 1].0.k == 0 {
                    continue;
                }
                for (e_idx, edge) in active_transitions.iter().enumerate() {
                    if stage_edge_best_intrinsic[s_idx][e_idx] <= 0.0 {
                        continue;
                    }
                    let mut best_next = 0.0f64;
                    let key = (edge.hop + 1, Some(edge.source_id), edge.target_id);
                    if let Some(successors) = next_edges_by_pred.get(&key) {
                        for &next_e_idx in successors {
                            let next_intrinsic = stage_edge_best_intrinsic[s_idx + 1][next_e_idx];
                            if next_intrinsic > 0.0 {
                                let total_future = next_intrinsic + 0.5 * beta_lookahead[s_idx + 1][next_e_idx];
                                if total_future > best_next {
                                    best_next = total_future;
                                }
                            }
                        }
                    }
                    beta_lookahead[s_idx][e_idx] = best_next;
                }
            }
        }

        let mut output = Vec::new();
        let mut selected: Vec<Selection> = Vec::new();
        let mut used_files = HashSet::new();
        let mut used_edges = HashSet::new();
        let mut optimization_hints: Vec<OptimizationHint> = Vec::new();

        for (s_idx, (stage, modules)) in stage_modules.iter().enumerate() {
            let mut results = Vec::new();
            for pick_iter in 0..stage.k {
                let mut offers = Vec::new();
                for module in modules {
                    if used_files.contains(&module.file_id) {
                        continue;
                    }
                    let mut best_route = None;
                    let mut best_parents = Vec::new();
                    let mut best_route_score = 0.0;
                    for (e_idx, edge) in active_transitions.iter().enumerate() {
                        if edge.immediate_return {
                            continue;
                        }
                        let (Some((a_pos, a_closure)), Some((b_pos, b_closure))) = (
                            module.tags.get(&edge.source_id),
                            module.tags.get(&edge.target_id),
                        ) else {
                            continue;
                        };
                        let hop_max = max_flow_by_hop.get(&edge.hop).copied().unwrap_or(maximum_flow).max(1e-12);
                        let flow_norm = 0.5 * (edge.flow / maximum_flow.max(1e-12)) + 0.5 * (edge.flow / hop_max);

                        // Inverse Topology Diagnostics (Counterfactual Bottleneck Detection on 1st pick):
                        if input.enable_diagnostics && pick_iter == 0 {
                            if *a_pos >= *b_pos && *a_closure >= input.min_closure && *b_closure >= input.min_closure {
                                let ind = artifact.independent_fraction(edge.source_id, edge.target_id, module.file_id);
                                let counterfactual = 0.65 * flow_norm * (a_closure * b_closure).sqrt() * ind;
                                if counterfactual >= 0.08 {
                                    optimization_hints.push(OptimizationHint {
                                        stage: stage.diary_name.clone(),
                                        module_id: module.id,
                                        bottleneck: "TAG_ORDER_INVERTED",
                                        potential_score_gain: (counterfactual * 10000.0).round() / 10000.0,
                                        source_tag_id: edge.source_id,
                                        target_tag_id: edge.target_id,
                                        prescription: format!(
                                            "Module #{} hits river edge [{} -> {}], but tag order is inverted (pos {} >= pos {}); swapping order unlocks +{:.3} route score.",
                                            module.id, edge.source_id, edge.target_id, a_pos, b_pos, counterfactual
                                        ),
                                    });
                                }
                            } else if *a_pos < *b_pos && (*a_closure < input.min_closure || *b_closure < input.min_closure) {
                                let min_c = a_closure.min(*b_closure);
                                if min_c >= input.min_closure * 0.65 {
                                    let ind = artifact.independent_fraction(edge.source_id, edge.target_id, module.file_id);
                                    let counterfactual = 0.65 * flow_norm * input.min_closure.max(0.25) * ind;
                                    if counterfactual >= 0.06 {
                                        optimization_hints.push(OptimizationHint {
                                            stage: stage.diary_name.clone(),
                                            module_id: module.id,
                                            bottleneck: "WEAK_TAG_CLOSURE",
                                            potential_score_gain: (counterfactual * 10000.0).round() / 10000.0,
                                            source_tag_id: edge.source_id,
                                            target_tag_id: edge.target_id,
                                            prescription: format!(
                                                "Module #{} matches edge [{} -> {}], but tag closure ({:.3}, {:.3}) is below min_closure {:.2}; grounding the concept in text unlocks +{:.3}.",
                                                module.id, edge.source_id, edge.target_id, a_closure, b_closure, input.min_closure, counterfactual
                                            ),
                                        });
                                    }
                                }
                            }
                        }

                        if *a_pos >= *b_pos
                            || *a_closure < input.min_closure
                            || *b_closure < input.min_closure
                        {
                            continue;
                        }
                        let mut best_relay_factor = 0.0f64;
                        let parents: Vec<i64> = selected
                            .iter()
                            .filter_map(|s| {
                                let prev = s.route.as_ref()?;
                                let factor = homotopy_continuation_factor(
                                    prev,
                                    edge,
                                    input.enable_homotopy_relay,
                                    &artifact,
                                    &global_tag_vecs,
                                )?;
                                if factor > best_relay_factor {
                                    best_relay_factor = factor;
                                }
                                Some(s.chunk_id)
                            })
                            .collect();
                        if edge.hop != 1 && parents.is_empty() {
                            continue;
                        }
                        let edge_key = (edge.hop, edge.previous_id, edge.source_id, edge.target_id);
                        let novelty = if used_edges.contains(&edge_key) {
                            0.2
                        } else {
                            1.0
                        };
                        let independent = artifact.independent_fraction(
                            edge.source_id,
                            edge.target_id,
                            module.file_id,
                        );
                        if input.enable_diagnostics && pick_iter == 0 && independent < 0.25 && flow_norm * (a_closure * b_closure).sqrt() > 0.20 {
                            let gain = 0.65 * flow_norm * (a_closure * b_closure).sqrt() * (0.85 - independent);
                            optimization_hints.push(OptimizationHint {
                                stage: stage.diary_name.clone(),
                                module_id: module.id,
                                bottleneck: "SELF_PROVENANCE_ONLY",
                                potential_score_gain: (gain * 10000.0).round() / 10000.0,
                                source_tag_id: edge.source_id,
                                target_tag_id: edge.target_id,
                                prescription: format!(
                                    "Edge [{} -> {}] in Module #{} has low external independence ({:.2}); citing this tag pair in an external note unlocks +{:.3}.",
                                    edge.source_id, edge.target_id, module.id, independent, gain
                                ),
                            });
                        }
                        // V8.5 Magnetic Laplacian Causal Phase Coherence + V9 Ricci Negative-Curvature Gain:
                        let chain_len = module.ordered_tags.len().max(2) as f64;
                        let phase_span = ((*b_pos as f64 - *a_pos as f64) / (chain_len - 1.0)).clamp(0.0, 1.0);
                        let magnetic_phase_gain = 0.96 + 0.08 * (std::f64::consts::FRAC_PI_2 * phase_span).sin();
                        let ricci_gain = 0.92 + 0.12 * artifact.edge_ricci_factor(edge.source_id, edge.target_id);
                        let base_score = flow_norm
                            * (a_closure * b_closure).sqrt()
                            * independent
                            * novelty
                            * magnetic_phase_gain
                            * ricci_gain;
                        let parent_factor = if parents.is_empty() {
                            0.8
                        } else {
                            best_relay_factor.clamp(0.8, 1.0)
                        };
                        let viterbi_future = if input.enable_viterbi_lookahead {
                            0.15 * beta_lookahead[s_idx][e_idx]
                        } else {
                            0.0
                        };
                        let score = (base_score * parent_factor + viterbi_future).min(1.0);
                        if score > best_route_score {
                            best_route_score = score;
                            best_route = Some(edge.clone());
                            best_parents = parents;
                        }
                    }
                    if pick_iter == 0 && best_route.is_none() && module.relevance >= 0.45 {
                        if let Some(top_edge) = observation.transitions.iter().find(|e| !e.immediate_return) {
                            let gain = 0.65 * 0.55 * module.relevance;
                            optimization_hints.push(OptimizationHint {
                                stage: stage.diary_name.clone(),
                                module_id: module.id,
                                bottleneck: "ISOLATED_MODULE_NO_FERRY",
                                potential_score_gain: (gain * 10000.0).round() / 10000.0,
                                source_tag_id: top_edge.source_id,
                                target_tag_id: top_edge.target_id,
                                prescription: format!(
                                    "Module #{} has high semantic relevance ({:.3}) but zero river ferry tags; anchoring onto active flow [{} -> {}] unlocks +{:.3}.",
                                    module.id, module.relevance, top_edge.source_id, top_edge.target_id, gain
                                ),
                            });
                        }
                    }
                    let relation = match &best_route {
                        Some(edge) if edge.wormhole => "analogy",
                        Some(_) if !best_parents.is_empty() => "continuation",
                        Some(_) => "root",
                        None => "supplement",
                    };
                    offers.push((
                        module.file_id,
                        Selection {
                            chunk_id: module.id,
                            score: 0.35 * module.relevance + 0.65 * best_route_score,
                            parents: best_parents,
                            relation,
                            route: best_route,
                        },
                    ));
                }
                offers.sort_by(|a, b| {
                    b.1.route
                        .is_some()
                        .cmp(&a.1.route.is_some())
                        .then_with(|| b.1.score.total_cmp(&a.1.score))
                        .then_with(|| a.1.chunk_id.cmp(&b.1.chunk_id))
                });
                let Some((file_id, choice)) = offers.into_iter().next() else {
                    break;
                };
                used_files.insert(file_id);
                if let Some(edge) = &choice.route {
                    used_edges.insert((edge.hop, edge.previous_id, edge.source_id, edge.target_id));
                }
                selected.push(choice.clone());
                results.push(choice);
            }
            output.push(StageOutput {
                diary_name: stage.diary_name.clone(),
                k: stage.k,
                results,
            });
        }
        if !selected.iter().any(|s| s.route.is_some()) {
            return Err("no grounded method route; use legacy chain".into());
        }

        // Industrial Inspiration Factory (Forward-Backward Latent Wormhole Collider):
        // Sweep cross-stage tag pairs (u in stage s, v in stage s+1) to discover high-potential
        // structural isomorphisms (cosine in Gaussian sweet spot [0.45, 0.85]) with zero/low historical co-occurrence.
        let mut latent_wormholes: Vec<LatentWormhole> = Vec::new();
        for s_idx in 0..num_stages.saturating_sub(1) {
            let (ref st_a, ref mods_a) = stage_modules[s_idx];
            let (ref st_b, ref mods_b) = stage_modules[s_idx + 1];
            for ma in mods_a.iter().take(8) {
                let alpha = (0.35 * ma.relevance + 0.65 * ma.ordered_tags.iter().map(|t| t.2).fold(0.0, f64::max)).max(0.2);
                for mb in mods_b.iter().take(8) {
                    if ma.file_id == mb.file_id {
                        continue;
                    }
                    let beta = (0.35 * mb.relevance + 0.65 * mb.ordered_tags.iter().map(|t| t.2).fold(0.0, f64::max)).max(0.2);
                    for &(u_id, _, u_closure) in ma.ordered_tags.iter().rev().take(3) {
                        if u_closure < input.min_closure {
                            continue;
                        }
                        let Some((ref u_vec, u_norm)) = global_tag_vecs.get(&u_id) else {
                            continue;
                        };
                        if *u_norm <= 1e-12 {
                            continue;
                        }
                        for &(v_id, _, v_closure) in mb.ordered_tags.iter().take(3) {
                            if u_id == v_id || v_closure < input.min_closure {
                                continue;
                            }
                            let hist_w = artifact.edge_weight(u_id, v_id);
                            if hist_w > 0.05 {
                                continue;
                            }
                            let Some((ref v_vec, v_norm)) = global_tag_vecs.get(&v_id) else {
                                continue;
                            };
                            if *v_norm <= 1e-12 {
                                continue;
                            }
                            let dot_uv: f64 = u_vec.iter().zip(v_vec.iter()).map(|(&a, &b)| (a as f64) * (b as f64)).sum();
                            let cos_uv = (dot_uv / (u_norm * v_norm)).clamp(-1.0, 1.0);
                            if (0.35..=0.88).contains(&cos_uv) {
                                let diff = (cos_uv - 0.65) / 0.20;
                                let sweet_gain = (-0.5 * diff * diff).exp();
                                let potential = alpha * beta * (u_closure * v_closure).sqrt() * sweet_gain / (1.0 + 10.0 * hist_w);
                                if potential >= 0.08 {
                                    latent_wormholes.push(LatentWormhole {
                                        from_stage: st_a.diary_name.clone(),
                                        to_stage: st_b.diary_name.clone(),
                                        from_module_id: ma.id,
                                        to_module_id: mb.id,
                                        source_tag_id: u_id,
                                        target_tag_id: v_id,
                                        structural_cosine: (cos_uv * 10000.0).round() / 10000.0,
                                        sweet_spot_gain: (sweet_gain * 10000.0).round() / 10000.0,
                                        inspiration_potential: (potential * 10000.0).round() / 10000.0,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        optimization_hints.sort_by(|a, b| b.potential_score_gain.total_cmp(&a.potential_score_gain));
        optimization_hints.truncate(10);
        latent_wormholes.sort_by(|a, b| b.inspiration_potential.total_cmp(&a.inspiration_potential));
        latent_wormholes.truncate(10);

        serde_json::to_string(&serde_json::json!({
            "schema": "vcp-river-thinking-plan-v1",
            "artifactSig": artifact_sig,
            "observationHandle": input.observation_handle,
            "stages": output,
            "diagnostics": {
                "optimizationHints": optimization_hints,
                "latentWormholes": latent_wormholes
            }
        }))
        .map_err(|e| e.to_string())
    })
}

pub struct ThinkingTask {
    pub(crate) runtime: Arc<MemoRuntime>,
    pub(crate) db_path: String,
    pub(crate) artifact_sig: String,
    pub(crate) input_json: String,
}

impl Task for ThinkingTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        plan(
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            &self.input_json,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_sensing::{sense_typed, SenseConfig, SenseInput, SenseSeed};
    use crate::rivermemo_topology_v3::NativeArtifact;

    fn artifact() -> NativeArtifact {
        NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 1, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.9, 0.9],
            inbound: HashMap::new(),
            max_inbound: 0.0,
            anchor_gain: HashMap::new(),
            wormhole_edges: HashSet::new(),
            provenance: HashMap::new(),
            ..NativeArtifact::default()
        }.prepared()
    }

    fn observation(graph: &NativeArtifact, limit: usize) -> crate::memo_sensing::SenseOutput {
        sense_typed(
            graph,
            "fixture",
            SenseInput {
                query_id: Some("test".into()),
                seeds: vec![SenseSeed {
                    id: 1,
                    energy: 1.0,
                    source_type: "seed".into(),
                }],
                config: SenseConfig {
                    max_transition_records: limit,
                    max_safe_hops: 3,
                    base_decay: 0.9,
                    firing_threshold: 0.001,
                    minimum_injected_current: 0.001,
                    ..SenseConfig::default()
                },
            },
        )
        .unwrap()
    }

    #[test]
    fn accepted_routes_preserve_propagation_and_reject_wrong_predecessor() {
        let graph = artifact();
        let plain = observation(&graph, 0);
        let recorded = observation(&graph, 100);
        assert!(plain.transitions.is_empty());
        assert_eq!(plain.source_field, recorded.source_field);
        assert_eq!(recorded.transitions.len(), 2);
        assert!(follows(&recorded.transitions[0], &recorded.transitions[1]));
        let mut wrong = recorded.transitions[1].clone();
        wrong.previous_id = Some(99);
        assert!(!follows(&recorded.transitions[0], &wrong));
        wrong = recorded.transitions[1].clone();
        wrong.immediate_return = true;
        assert!(!follows(&recorded.transitions[0], &wrong));
        let bounded = observation(&graph, 1);
        assert!(bounded.transitions_truncated);
        assert_eq!(bounded.transitions.len(), 1);
        assert_eq!(plain.source_field, bounded.source_field);
    }

    #[test]
    fn planning_uses_routes_and_scope_not_just_relevance() {
        let graph = Arc::new(artifact());
        let runtime = MemoRuntime::new();
        runtime.publish("fixture", graph.clone()).unwrap();
        let sensed = observation(&graph, 100);
        let handle = runtime
            .store_query_observation(
                "fixture",
                sensed,
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
                Arc::new(HashMap::new()),
                0,
            )
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "vcp-thinking-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db_path = path.to_str().unwrap();
        let (storage, _) =
            crate::storage::SqliteStorageEngine::open_and_init(
                &path,
                crate::storage::StorageOptions::default(),
            )
            .unwrap();
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, diary_name TEXT);
                 CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, file_id INTEGER, vector BLOB);
                 CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, vector BLOB);
                 CREATE TABLE IF NOT EXISTS file_tags(file_id INTEGER, tag_id INTEGER, position INTEGER);",
            )
            .unwrap();
            let bytes = |v: [f32; 2]| v.into_iter().flat_map(f32::to_ne_bytes).collect::<Vec<_>>();
            for id in 1..=3 {
                db.execute(
                    "INSERT INTO tags(name, vector) VALUES(?1, ?2)",
                    rusqlite::params![format!("tag-{}", id), bytes([1.0, 0.0])],
                )
                .unwrap();
            }
            for (id, diary, vector) in [
                (10, "A", [0.8, 0.6]),
                (20, "B", [0.8, 0.6]),
                (21, "B", [1.0, 0.0]),
                (22, "Other", [1.0, 0.0]),
            ] {
                db.execute(
                    "INSERT INTO files(id, path, diary_name, checksum, mtime, size) \
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        id,
                        format!("{}.md", id),
                        diary,
                        format!("checksum-{}", id),
                        0_i64,
                        0_i64
                    ],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO chunks(id, file_id, chunk_index, content, vector) \
                     VALUES(?1, ?1, 0, ?2, ?3)",
                    rusqlite::params![id, format!("chunk-{}", id), bytes(vector)],
                )
                .unwrap();
            }
            for (file, tags) in [(10, [1, 2]), (20, [2, 3]), (21, [3, 2]), (22, [2, 3])] {
                for (pos, tag) in tags.into_iter().enumerate() {
                    db.execute(
                        "INSERT INTO file_tags VALUES(?1,?2,?3)",
                        rusqlite::params![file, tag, pos as i64],
                    )
                    .unwrap();
                }
            }
            db.execute_batch(
                "INSERT INTO rivermemo_artifacts(
                   artifact_sig,schema_version,algorithm_version,source_v9_artifact_sig,
                   source_graph_generation,model_sig,config_hash,database_generation,
                   provenance_generation,status,created_at,updated_at)
                 VALUES('fixture','rivermemo-persisted-artifact-v2','memo.native-artifact-v2-binary','test','test','test','test','0','test','ready',0,0);
                 INSERT INTO kbm_artifact_dependencies
                 SELECT 'fixture',key,value FROM kbm_runtime_meta
                 WHERE key IN ('memo_tag_facts','derived_geometry');"
            ).unwrap();
        }
        let input = serde_json::json!({
            "observationHandle": handle,
            "stages": [
                {"diaryName":"A","k":1,"candidateIds":[10]},
                {"diaryName":"B","k":1,"candidateIds":[21,22,20]},
                {"diaryName":"A","k":0,"candidateIds":[10]}
            ]
        });
        let output: serde_json::Value =
            serde_json::from_str(&plan(&runtime, db_path, "fixture", &input.to_string()).unwrap())
                .unwrap();
        assert_eq!(output["stages"][0]["results"][0]["chunkId"], 10);
        assert_eq!(output["stages"][1]["results"][0]["chunkId"], 20);
        assert_eq!(
            output["stages"][1]["results"][0]["parents"],
            serde_json::json!([10])
        );
        assert_eq!(
            output["stages"][1]["results"][0]["relation"],
            "continuation"
        );
        assert_eq!(output["stages"][2]["results"], serde_json::json!([]));
        // Verify Inverse Topology Diagnostics caught module #21's inverted tag order [3, 2] vs river edge 2 -> 3!
        let hints = output["diagnostics"]["optimizationHints"].as_array().unwrap();
        assert!(
            hints.iter().any(|h| h["moduleId"] == 21 && h["bottleneck"] == "TAG_ORDER_INVERTED"),
            "Inverse topology diagnostics must detect TAG_ORDER_INVERTED on module 21: {:?}",
            hints
        );
        // Verify V9 Homotopy Continuation Kernel & Isolation Flags
        let e1 = ObservationTransition {
            hop: 1,
            previous_id: None,
            source_id: 1,
            target_id: 2,
            flow: 0.6,
            wormhole: false,
            immediate_return: false,
        };
        let e2_homotopy = ObservationTransition {
            hop: 2,
            previous_id: Some(2),
            source_id: 3,
            target_id: 1,
            flow: 0.5,
            wormhole: false,
            immediate_return: false,
        };
        let e2_valid_bridge = ObservationTransition {
            hop: 2,
            previous_id: Some(2),
            source_id: 3,
            target_id: 99,
            flow: 0.5,
            wormhole: false,
            immediate_return: false,
        };
        assert!(!follows(&e1, &e2_valid_bridge));
        assert!(homotopy_continuation_factor(&e1, &e2_homotopy, true, &graph, &HashMap::new()).is_none());
        assert!(homotopy_continuation_factor(&e1, &e2_valid_bridge, false, &graph, &HashMap::new()).is_none());
        let relay = homotopy_continuation_factor(&e1, &e2_valid_bridge, true, &graph, &HashMap::new());
        assert!(relay.is_some_and(|f| f >= 0.85));

        runtime.clear().unwrap();
        assert!(plan(&runtime, db_path, "fixture", &input.to_string()).is_err());
        storage.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
